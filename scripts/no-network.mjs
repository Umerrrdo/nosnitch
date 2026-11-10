// Preload used by the tests: node --import ./scripts/no-network.mjs dist/cli.js ...
// Any attempt to open a socket, resolve a name or call fetch prints a marker and throws.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const MARKER = "NOSNITCH_NETWORK_ATTEMPT";

function block(what) {
  return function blocked() {
    process.stderr.write(`${MARKER}: ${what}\n`);
    throw new Error(`${MARKER}: ${what}`);
  };
}

net.Socket.prototype.connect = block("net.Socket.connect");
net.connect = block("net.connect");
net.createConnection = block("net.createConnection");
dns.lookup = block("dns.lookup");
dns.resolve = block("dns.resolve");
http.request = block("http.request");
http.get = block("http.get");
https.request = block("https.request");
https.get = block("https.get");
globalThis.fetch = block("fetch");
