var Controller = require('./controller');
const http = require('http');
url = require("url")

// :: constraints ::
var SERVER_PORT = 5555;

// :: client commands ::
var COMMAND_OFF = "/off";
var COMMAND_COLOR = "/rgb";

// :: server response to commands ::
var RESPONSE_OK = "OK";
var RESPONSE_PENDING = "PENDING";
var RESPONSE_ERROR = "BAD REQUEST";

function Server(controller) {
    this._controller = controller;
};

Server.prototype.start = function() {
     server = http.createServer((req, res) => {
        this._controller.connect();
        var url_parts = url.parse(req.url, true);
        var search = url_parts.search;
        search = search.slice(1, search.length);
        var pathname = url_parts.pathname
        console.log(pathname);
        console.log(search);
        this._processRequest(pathname, search);
    });

    server.listen(SERVER_PORT, () => {
      console.log('Server running at port: ' + SERVER_PORT);
    });
};

Server.prototype._parseColorParam = function (hexstr) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexstr.substr(2));
    return result ? [
        parseInt(result[1], 16) / 255.,
        parseInt(result[2], 16) / 255.,
        parseInt(result[3], 16) / 255.,
    ] : null;
};

Server.prototype._processRequest = function (pathname, search) {
    var pending = false;
    console.log("pathname: " + pathname);

    // Imperative commands
    if (pathname === COMMAND_OFF) {
        pending = this._controller.command(Controller.Commands.TURN_OFF);
    } else if (pathname === COMMAND_COLOR) {
        if (search === null)
            return RESPONSE_ERROR;

        if (search.length != 8 || search.slice(0,2) != "0x")
            return RESPONSE_ERROR;

        var color = this._parseColorParam(search);
        if (! color)
            return RESPONSE_ERROR;

        pending = this._controller.command(Controller.Commands.COLOR, color);
    }

    if (pending)
        return RESPONSE_PENDING;
    else
        return RESPONSE_OK;
};

module.exports = {
    'Server': Server,
};
