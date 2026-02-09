const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

class LogWatcher extends EventEmitter {
    constructor() {
        super();
        this.watcher = null;
        this.filePath = null;
        this.isWatching = false;
        this.lastSize = 0;
        this.lastLocationHint = null; // Debounce location hints
        this.seenLocations = new Set(); // Deduplicate location hints during initial read

        // Regex Patterns
        this.patterns = {
            login: /Cloud Imperium Games Public Auth Service/i,
            login_success: /CDisciplineServiceExternal::OnLoginStatusChanged.*LoggedIn/,
            location: /Global location: <(.*?)>/, // Legacy
            location_obj: /data\/objectcontainers\/pu\/loc\/(?:flagship|mod)\/([^\/]+)\/([^\/]+)\//, // New Object Container Tracking
            quantum_enter: /Quantum Travel: Entering/i,
            quantum_exit: /Quantum Travel: Exiting/i,

            // Zones via HUD Notifications
            armistice_enter: /SHUDEvent_OnNotification.*Entering Armistice Zone/i,
            armistice_leave: /SHUDEvent_OnNotification.*Leaving Armistice Zone/i,
            monitored_enter: /SHUDEvent_OnNotification.*Entered Monitored Space/i,

            // Status
            suffocating: /Player.*started suffocating/i,
            depressurizing: /Player.*started depressurization/i,
            die: /Actor Death/i,

            // Combat
            vehicle_spawn: /Vehicle Spawned: (.*?) - (.*?)/
        };
    }

    findLogFile() {
        const candidates = [];

        // Windows paths
        const drivers = ['C:', 'D:', 'E:', 'F:'];
        const winPaths = [
            'Program Files/Roberts Space Industries/Star Citizen/LIVE/Game.log',
            'Roberts Space Industries/Star Citizen/LIVE/Game.log',
            'StarCitizen/LIVE/Game.log'
        ];
        for (const drive of drivers) {
            for (const p of winPaths) {
                candidates.push(path.join(drive, p));
            }
        }

        // Linux paths (Wine / Lutris / Proton)
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home) {
            candidates.push(
                path.join(home, '.wine/drive_c/Program Files/Roberts Space Industries/Star Citizen/LIVE/Game.log'),
                path.join(home, 'Games/star-citizen/drive_c/Program Files/Roberts Space Industries/Star Citizen/LIVE/Game.log'),
                path.join(home, '.local/share/lutris/runners/wine/star-citizen/Game.log')
            );
        }

        // macOS paths (CrossOver)
        if (home) {
            candidates.push(
                path.join(home, 'Library/Application Support/CrossOver/Bottles/Star Citizen/drive_c/Program Files/Roberts Space Industries/Star Citizen/LIVE/Game.log')
            );
        }

        // Project-local fallback (for development/testing)
        candidates.push(
            path.join(__dirname, '..', 'Game.log')
        );

        for (const fullPath of candidates) {
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
        return null;
    }

    /**
     * Read the last N lines from a file (for initial state parsing)
     */
    readLastLines(filePath, maxLines = 10000) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            return lines.slice(-maxLines);
        } catch (e) {
            console.error('[LogWatcher] Failed to read file:', e.message);
            return [];
        }
    }

    start(customPath = null) {
        if (this.isWatching) return;

        this.filePath = customPath || this.findLogFile();

        if (!this.filePath) {
            this.emit('error', 'Game.log not found. Please locate it manually via Configuration tab.');
            return;
        }

        console.log(`[LogWatcher] Starting on: ${this.filePath}`);
        this.emit('status', { connected: true, path: this.filePath });

        // STEP 1: Process existing file content
        console.log('[LogWatcher] Reading existing log content...');
        this.seenLocations.clear();
        const existingLines = this.readLastLines(this.filePath, 50000);
        let matchCount = 0;
        for (const line of existingLines) {
            if (this.processLine(line, true)) matchCount++;
        }
        console.log(`[LogWatcher] Initial scan complete: ${matchCount} events found in ${existingLines.length} lines`);

        // STEP 2: Watch for NEW lines appended to the file
        try {
            const stat = fs.statSync(this.filePath);
            this.lastSize = stat.size;

            // Use fs.watchFile for reliable cross-platform polling
            fs.watchFile(this.filePath, { interval: 1000 }, (curr, prev) => {
                if (curr.size > this.lastSize) {
                    // Read only the new bytes
                    const stream = fs.createReadStream(this.filePath, {
                        start: this.lastSize,
                        end: curr.size - 1,
                        encoding: 'utf-8'
                    });

                    let buffer = '';
                    stream.on('data', (chunk) => { buffer += chunk; });
                    stream.on('end', () => {
                        const newLines = buffer.split('\n');
                        for (const line of newLines) {
                            if (line.trim()) this.processLine(line, false);
                        }
                    });
                    stream.on('error', (err) => this.emit('error', err.message));

                    this.lastSize = curr.size;
                } else if (curr.size < this.lastSize) {
                    // File was truncated (game restarted), reset
                    console.log('[LogWatcher] File truncated - game may have restarted');
                    this.lastSize = curr.size;
                }
            });

            this.isWatching = true;
            console.log('[LogWatcher] Now watching for new log entries...');
        } catch (e) {
            this.emit('error', `Failed to watch file: ${e.message}`);
        }
    }

    stop() {
        if (this.filePath) {
            fs.unwatchFile(this.filePath);
        }
        this.isWatching = false;
        this.emit('status', { connected: false });
    }

    setPath(newPath) {
        console.log(`[LogWatcher] Switching to manual path: ${newPath}`);
        this.stop();
        this.start(newPath);
    }

    processLine(line, initialRead = false) {
        if (!line || !line.trim()) return false;
        let matched = false;

        // 1. Location (Global)
        const locMatch = line.match(this.patterns.location);
        if (locMatch) {
            this.emit('gamestate', { type: 'LOCATION', value: locMatch[1].trim() });
            return true;
        }

        // 2. Quantum
        if (this.patterns.quantum_enter.test(line)) {
            this.emit('gamestate', { type: 'QUANTUM', value: 'entered' });
            matched = true;
        } else if (this.patterns.quantum_exit.test(line)) {
            this.emit('gamestate', { type: 'QUANTUM', value: 'exited' });
            matched = true;
        }

        // 3. Zone State (Armistice / Monitored)
        if (this.patterns.armistice_enter.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'armistice_enter' });
            matched = true;
        } else if (this.patterns.armistice_leave.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'armistice_leave' });
            matched = true;
        } else if (this.patterns.monitored_enter.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'monitored_enter' });
            matched = true;
        }

        // 4. Player Status (Suffocation / Death Proxy)
        if (this.patterns.suffocating.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'suffocating' });
            matched = true;
        } else if (this.patterns.depressurizing.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'depressurizing' });
            matched = true;
        } else if (this.patterns.die.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'death' });
            matched = true;
        }

        // 5. Login Status
        if (this.patterns.login_success.test(line)) {
            this.emit('login', { status: 'connected' });
            matched = true;
        }

        // 6. Fallback Location (Object Containers) - deduplicated
        const objMatch = line.match(this.patterns.location_obj);
        if (objMatch) {
            const system = objMatch[1];
            const location = objMatch[2];
            const key = `${system}/${location}`;

            // During initial read: deduplicate (there are thousands of these)
            if (initialRead) {
                if (!this.seenLocations.has(key)) {
                    this.seenLocations.add(key);
                    this.emit('gamestate', { type: 'LOCATION_HINT', value: key });
                    matched = true;
                }
            } else {
                // Live mode: only emit if different from last
                if (key !== this.lastLocationHint) {
                    this.lastLocationHint = key;
                    this.emit('gamestate', { type: 'LOCATION_HINT', value: key });
                    matched = true;
                }
            }
        }

        return matched;
    }
}

module.exports = new LogWatcher();
