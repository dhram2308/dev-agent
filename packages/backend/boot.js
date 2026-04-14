#!/usr/bin/env node
"use strict";

// Boot: Web UI server (TypeScript compiled)
require("./register-aliases");
require("./dist/server/http-server").startServer();
