#!/usr/bin/env node
import { main } from "./commands.ts";

await main(process.argv.slice(2));
