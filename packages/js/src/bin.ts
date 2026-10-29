#!/usr/bin/env node
import { runCli } from './cli.js';

declare const process: any;
runCli(process.argv.slice(2)).then((c) => { process.exitCode = c; });
