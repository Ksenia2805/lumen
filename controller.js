var Lumen = require('lumen');

var INTERPOLATION_INTERVAL = 40;        // milliseconds before interpolation step
var COLOR_STEP = 0.01;                  // step for color mode
var CONNECTION_TIMEOUT = 10000;         // retriggers _evaluateUserDecision when lumen connection fails without error

var Modes = {
    COLOR: 'color',
    WHITE: 'white',
    DISCO: 'disco',
    COOL: 'cool'
    // TODO add Warm mode support
};

var Commands = {
    TURN_OFF: 'off',
    COLOR: 'color'
    // TODO add Warm command
};

var Controller = function () {
    // information variables
    this.mode = Modes.WHITE;
    this.color = [1.0, 1.0, 1.0];
    this.white = 1.0;
    this.lighton = true;

    // last user decision variables
    this._wants_connected = false;
    this._wants_disconnected = false;
    this._stopped = true;               // true if there are no pending actions by previous decision

    // flow control stuff
    this._lumen = null;                 // true if we are bound to a lumen (after successfull discovery)
    this._discovery_listener = null;    // <> null indicates that a discovery listener is set
    this._discovering = false;          // true if we are actively discovering
    this._connecting = false;           // true if we are actively connecting
    this._disconnecting = false;        // true if we are actively disconnecting
    this._initialsync = false;          // true if we are actively sending initial synchronization
    this.ready = false;                 // true if we are bound and connected
    this._watchdog = null;

    // internal status
    this._pending = null;               // .action, .value
    this._busy = true;                  // !_busy => _pending = null

    // interpolation stuff
    this._initial = [1.0, 1.0, 1.0];    // initial interpolation value
    this._target = [1.0, 1.0, 1.0];     // final interpolation value
    this._interpwait = false;
    this._progress = 0.0;
    this._timer = null;
};

/* updates internal state to begin evaluating user decisions */
Controller.prototype._makeUserDecision = function() {
    //this._evaluateUserDecision();
    if (this._stopped) {
        this._stopped = false;
        this._evaluateUserDecision();
    } else if (this._wants_disconnected && this._discovering) {
        // we must stop it here
        console.log('here')
        Lumen.stopDiscoverAll(this._discovery_listener);
        this._discovering = false;
        this._stopped = true;
        console.log('_stopped = true')
    }
};

Controller.prototype._onWatchdog = function() {
    this._watchdog = null;

    if (this._wants_connected && this._connecting && !this._lumen.connectedAndSetUp) {
        // we should cancel the connection here...but how?
        if (this._lumen._peripheral.state === 'disconnected') {
            console.log("Connection attempt hang");
            this._connecting = false;
            this._evaluateUserDecision();
        } else {
            // it is still trying to connect, will check later
            this._watchdog = setTimeout(this._onWatchdog.bind(this), CONNECTION_TIMEOUT);
        }
    }
};

/* this function is critical: decides what to do after each asynchronous command */
Controller.prototype._evaluateUserDecision = function(arg) {
    if (this._wants_connected) {
        this._disconnecting = false;

        if (! this._lumen) {
            // not bound yet
            console.log('_evaluateUserDecision');
            // this._doDiscover();
            // this._onDiscovered(arg)
            if (! this._discovering) {                
                this._doDiscover();
            }
            else
                this._onDiscovered(arg);
        } else if (! this.ready) {
            // we are bound but not ready yet
            if (! this._connecting && ! this._initialsync)
                this._doConnect();
            else if (this._connecting)
                this._onConnected(arg);
            else // (this._initialsync)
                this._onInitialStatusSynched();
        } else {
            // nothing more to do
            this._stopped = true;
        }
    } else if (this._wants_disconnected && this._lumen) {
        // we are bound
        if (this._connecting || this._initialsync || this.ready) {
            // before _onConnected or _onInitialStatusSynched
            this._doDisconnect();
            this._connecting = false;
            this._initialsync = false;
        } else if (this._disconnecting) {
            this._onDisconnected();
        } else {
            this._stopped = true;
        }
    } else {
        this._stopped = true;
    }
};

/* POST: _discovering = true */
Controller.prototype._doDiscover = function() {
    console.log("Start discovering...");
    this._discovering = true;

    if (!this._discovery_listener)
        // need to keep a reference to remove on stopDiscoverAll
        this._discovery_listener = this._evaluateUserDecision.bind(this);

    // discovering process is handled by noble, only one device at a time
    Lumen.discoverAll(this._discovery_listener);
};

/* PRE: _discovering = true
 * POST: _discovering = false & _lumen <> null */
Controller.prototype._onDiscovered = function(lumen) {
    console.log("Lumen bound: " + lumen.toString());
    this._discovering = false;
    this._lumen = lumen;
    this._lumen.on('disconnect', this._handleDisconnect.bind(this));

    // continue
    this._evaluateUserDecision();
};

Controller.prototype._handleDisconnect = function() {
    // react if we are not running
    if (this._stopped && this._wants_connected) {
        this.ready = false;
        this._stopped = false;
        this._evaluateUserDecision();
    }
};

/* PRE: _lumen <> null & _connecting = false & _initialsync = false
 * POST: _connecting = true
 */
Controller.prototype._doConnect = function() {
    console.log("Connecting...");
    this._connecting = true;

    /* Currently it is not possible to know if a connectAndSetUp will wait
     * forever. See https://github.com/sandeepmistry/noble/issues/229
     * This uses a timer to prevent hanging
     */
    if (this._watchdog)
        clearTimeout(this._watchdog);
    this._watchdog = setTimeout(this._onWatchdog.bind(this), CONNECTION_TIMEOUT);

    this._lumen.connectAndSetUp(this._evaluateUserDecision.bind(this));
};

/* PRE: _lumen <> null & _connecting = true
 * POST: error -> _connecting = false & _initialsync = false
 *      !error -> _connecting = false & _initialsync = true
 */
Controller.prototype._onConnected = function(error) {
    this._connecting = false;

    if (error) {
        console.log('Lumen connection error, retry...');

        // retry
        this._initialsync = false;
        this._evaluateUserDecision();
    } else {
        this._initialsync = true;
        if (this._pending) {
            // when there is a pending command, execute it
            var cmd = this._pending;
            this._pending = null;
            this._executeCommand(cmd, this._evaluateUserDecision.bind(this));
            // TODO add Warm command
        } else if (this.mode === Modes.DISCO || this.mode === Modes.COOL || this.mode == Modes.SOFT) {
            // these are special modes, setting them again will not be pleasant
            this._evaluateUserDecision.bind(this);
        } else {
            // set my state to the lumen
            this._syncStatus(this._evaluateUserDecision.bind(this));
        }
    }
};

/* PRE: _lumen <> null & _initialsync = true
 * POST: _initialsync = false & ready = true & _busy = false
 */
Controller.prototype._onInitialStatusSynched = function() {
    console.log('Lumen connected');
    this._initialsync = false;
    this._busy = false;
    this.ready = true;

    // end
    this._evaluateUserDecision();
};

/* PRE: _lumen <> null & (_connecting | _initialsync | ready)
 * POST: ready = false & _disconnecting = true
 */
Controller.prototype._doDisconnect = function() {
    console.log("Disconnecting...");
    this._disconnecting = true;
    this.ready = false;
    this._lumen.disconnect(this._evaluateUserDecision.bind(this));
}

/* PRE: _lumen <> null & _disconnecting = true
 * POST: _disconnecting = false*/
Controller.prototype._onDisconnected = function() {
    this._disconnecting = false;
    console.log("Lumen disconnected");

    // end
    this._evaluateUserDecision();
};

// sync internal status to the lumen
Controller.prototype._syncStatus = function(callback) {
    if (this.lighton === false)
        this._lumen.turnOff(callback);
    else if (this.mode === Modes.COLOR)
        this._lumen.color(this.color[0]*99, this.color[1]*99, this.color[2]*99, callback);
    else
        console.log("Unknown mode", this.mode);
};

Controller.prototype._executePendingCommand = function() {
    if (! this.ready)
        return;

    if (this._pending) {
        var cmd = this._pending;
        this._pending = null;
        this._executeCommand(cmd, this._executePendingCommand.bind(this));
    } else {
        this._busy = false;
    }
};

/* stop any interpolation or long operation on the device */
Controller.prototype._stopAnyWork = function() {
    if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
    }
    this._interpwait = false;
};

Controller.prototype._onTimer = function() {
    if (! this.ready) {
        this._interpwait = false;
        return;
    }

    this._progress = Math.min(Math.max(0.0, this._progress + this._interpstep), 1.0);
    if (this._interpwait)
        // skip
        return;

    var p = this._progress;
    this.color = [
        this._initial[0] * (1-p) + this._target[0] * p,
        this._initial[1] * (1-p) + this._target[1] * p,
        this._initial[2] * (1-p) + this._target[2] * p,
    ];
    this._interpwait = true;
    this._syncStatus(function() {
        this._interpwait = false;
        if (this._progress == 1.0)
            // interpolation end
            if (this.mode === Modes.SOFT)
                this._softmodeNextStep();
            else
                this._stopAnyWork();
    }.bind(this));
};

/* Modes.COLOR | Modes.SOFT */
Controller.prototype._startInterpolationWork = function(target, step) {
    this._progress = 0.0;
    this._initial = this.color;
    this._target = target;
    this._interpstep = step;

    if (! this._timer)
        this._timer = setInterval(this._onTimer.bind(this), INTERPOLATION_INTERVAL);
};

Controller.prototype._executeCommand = function(cmd, callback) {
    var action = cmd.action;
    var value = cmd.value;
    console.log("hello");

    this._busy = true;
    console.log('color');

    if (action === Commands.TURN_OFF) {
        if (this.lighton) {
            this._stopAnyWork();
            this.lighton = false;
            this._syncStatus(callback);
        } else {
            callback();
        }
    } else if (action === Commands.COLOR) {
        this._debugStatus();
        if (this.mode === Modes.COLOR || this.mode === Modes.SOFT) {
            this.mode = Modes.COLOR;
            this._startInterpolationWork(value, COLOR_STEP);
            callback();
        } else {
            // current color is not relevant, set color directly
            this.mode = Modes.COLOR;
            this.color = value;
            this._syncStatus(callback);
            console.log('color');
        }
    } else {
        console.log("ERROR: unrecognized command: ", action);
        callback();
    }
    this._debugStatus();
    //this._stopped = false;
    //this._lumen = false;
    //console.log("disconnect");
};

/* returns true if action is pending, false otherwise */
Controller.prototype.command = function(action, value) {
    cmd = {'action':action, 'value':value};
    console.log(cmd);

    // ensure we are connected
    this.connect();

    if (this._busy || ! this.ready) {
        this._pending = cmd;
        console.log(true);
        console.log(this._busy);
        return true;
    } else {
        this._executeCommand(cmd, this._executePendingCommand.bind(this));
        //this.disconnect();
        console.log(false);
        return false;
    }
};

/* start/restart device connection */
Controller.prototype.connect = function() {
    console.log('connect');
    this._wants_connected = true;
    this._wants_disconnected = false;
    this._makeUserDecision();
};

/* stop any action we are taking to connect */
Controller.prototype.disconnect = function() {
    // in soft mode, we need to be connected
    if (this.mode === Modes.SOFT)
        return;

    this._wants_connected = false;
    this._wants_disconnected = true;
    this._makeUserDecision();
};

Controller.prototype._debugStatus = function() {
    console.log("\n_lumen:", (this._lumen !== null), "\nready:", this.ready,
      "\n_stopped:", this._stopped, "\n_discovering:", this._discovering,
      "\n_connecting:",this._connecting, "\n_disconnecting:", this._disconnecting,
      "\n_initialsync:", this._initialsync);
};

module.exports = {
    'Controller': Controller,
    'Commands': Commands,
    'Modes': Modes,
};
