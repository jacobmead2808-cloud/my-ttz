'use strict';
// Single entry point for hosts that run one "main file" (e.g. game/app panels such as Enzonic):
// runs the first-boot setup, then starts the server. Uses the panel's SERVER_PORT when given.
const { execFileSync } = require('child_process');
const path = require('path');

if (!process.env.PORT && process.env.SERVER_PORT) process.env.PORT = process.env.SERVER_PORT;
execFileSync(process.execPath, [path.join(__dirname, 'server', 'scripts', 'bootstrap.js')], { stdio: 'inherit' });
require('./server/index.js').start();
