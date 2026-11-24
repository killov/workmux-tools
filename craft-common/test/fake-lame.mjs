#!/usr/bin/env node
// A stand-in for `lame --quiet -b <kbps> <in> <out>` in the bridge tests: writes "-b <kbps> <input>" to <out>. An
// input "FAIL" leaves a partial output and exits 1 like lame on a WAV it cannot read.

import fs from "node:fs";

const [, , quiet, b, kbps, input, output] = process.argv;
if (quiet !== "--quiet" || b !== "-b") {
  console.error(`unexpected arguments ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
const data = fs.readFileSync(input, "utf8");
fs.writeFileSync(output, `-b ${kbps} ${data}`);
if (data === "FAIL") {
  console.error("Unsupported data format: 0x0000");
  process.exit(1);
}
