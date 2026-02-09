const fs = require('fs');
const path = require('path');
const { Tail } = require('tail'); // using 'tail' package for simplicity, or 'tail-stream'
const { EventEmitter } = require('events');

class LogWatcher extends EventEmitter {
    constructor() {
        super();
        this.tail = null;
        this.filePath = null;
        this.isWatching = false;

        // Regex Patterns
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
        // Standard Locations
        const drivers = ['C:', 'D:', 'E:', 'F:'];
        const commonPaths = [
            'Program Files/Roberts Space Industries/Star Citizen/LIVE/Game.log',
            'Roberts Space Industries/Star Citizen/LIVE/Game.log',
            'StarCitizen/LIVE/Game.log'
        ];

        for (const drive of drivers) {
            for (const p of commonPaths) {
                const fullPath = path.join(drive, p);
                if (fs.existsSync(fullPath)) {
                    return fullPath;
                }
            }
        }
        return null;
    }

    start(customPath = null) {
        if (this.isWatching) return;

        this.filePath = customPath || this.findLogFile();

        if (!this.filePath) {
            this.emit('error', 'Game.log not found. Please locate it manually.');
            return;
        }

        console.log(`[LogWatcher] Tailing: ${this.filePath}`);
        this.emit('status', { connected: true, path: this.filePath });

        // Tail the file
        try {
            this.tail = new Tail(this.filePath, {
                useWatchFile: true, // Better for Windows often
                fsWatchOptions: { interval: 500 }
            });

            this.tail.on('line', (line) => this.processLine(line));
            this.tail.on('error', (err) => this.emit('error', err));
            this.tail.watch();
            this.isWatching = true;

        } catch (e) {
            this.emit('error', `Failed to watch file: ${e.message}`);
        }
    }

    stop() {
        if (this.tail) {
            this.tail.unwatch();
            this.tail = null;
        }
        this.isWatching = false;
        this.emit('status', { connected: false });
    }

    setPath(newPath) {
        console.log(`[LogWatcher] Switching to manual path: ${newPath}`);
        this.stop();
        this.start(newPath);
    }

    processLine(line) {
        // 1. Location
        const locMatch = line.match(this.patterns.location);
        if (locMatch) {
            this.emit('gamestate', { type: 'LOCATION', value: locMatch[1] });
            return;
        }

        // 2. Quantum
        if (this.patterns.quantum_enter.test(line)) {
            this.emit('gamestate', { type: 'QUANTUM', value: 'entered' });
        } else if (this.patterns.quantum_exit.test(line)) {
            this.emit('gamestate', { type: 'QUANTUM', value: 'exited' });
        }

        // 3. Zone State (Armistice / Monitored)
        if (this.patterns.armistice_enter.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'armistice_enter' });
        } else if (this.patterns.armistice_leave.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'armistice_leave' });
        } else if (this.patterns.monitored_enter.test(line)) {
            this.emit('gamestate', { type: 'ZONE', value: 'monitored_enter' });
        }

        // 4. Player Status (Suffocation / Death Proxy)
        if (this.patterns.suffocating.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'suffocating' });
        } else if (this.patterns.depressurizing.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'depressurizing' });
        } else if (this.patterns.die.test(line)) {
            this.emit('gamestate', { type: 'STATUS', value: 'death' });
        }

        // 5. Login Status
        if (this.patterns.login_success.test(line)) {
            this.emit('login', { status: 'connected' });
        }

        // 6. Fallback Location (Object Containers) - "data/objectcontainers/pu/loc/flagship/stanton/orison/..."
        const objMatch = line.match(this.patterns.location_obj);
        if (objMatch) {
            // objMatch[1] = system (stanton), objMatch[2] = location (orison)
            const system = objMatch[1];
            const location = objMatch[2];
            this.emit('gamestate', { type: 'LOCATION_HINT', value: `${system}/${location}` });
        }
    }
}

module.exports = new LogWatcher();
