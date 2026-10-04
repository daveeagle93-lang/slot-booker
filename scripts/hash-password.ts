// Prints the ADMIN_PASSWORD_HASH value for a password: pbkdf2-sha256$<iterations>$<salt>$<hash>.
//
//   npm run hash-password            prompts twice on the terminal, without echo
//   printf '%s' "$PW" | npm run hash-password    reads stdin when it is not a terminal
//
// The password is never taken from the command line (it would end up in shell history and the process list).
import { hashPassword } from "../src/server/auth/crypto.ts";

const MIN_LENGTH = 14;
const MAX_LENGTH = 256; // UTF-16 code units: what the login form (maxlength) and POST /api/admin/login (password.length) accept

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** One line from the terminal with echo off. Ctrl-C aborts; Backspace edits. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        } else if (ch === "\u007f" || ch === "\b") {
          value = [...value].slice(0, -1).join("");
        } else {
          value += ch;
        }
      }
    };
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

if (process.argv.length > 2) die("This script takes no arguments: a password on the command line would be recorded in shell history.\nRun it with no arguments and type the password when asked, or pipe it in on stdin.");

let password: string;
if (process.stdin.isTTY) {
  password = await promptHidden("Admin password: ");
  if (password !== (await promptHidden("Again to confirm: "))) die("The two entries differ.");
} else {
  password = await readStdin();
}
if ([...password].length < MIN_LENGTH) die(`The password must be at least ${MIN_LENGTH} characters.`);
if (password.length > MAX_LENGTH) die(`The password must be at most ${MAX_LENGTH} characters (UTF-16 code units; an emoji counts as 2), or the login page can't send it.`);
process.stdout.write(`${await hashPassword(password)}\n`);
