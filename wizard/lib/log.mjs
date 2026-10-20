const tty = Boolean(process.stdout.isTTY);
const BOLD = tty ? "\x1b[1m" : "";
const GREEN = tty ? "\x1b[32m" : "";
const YELLOW = tty ? "\x1b[33m" : "";
const RED = tty ? "\x1b[31m" : "";
const RESET = tty ? "\x1b[0m" : "";

export function step(title) {
  console.log(`\n${BOLD}== ${title} ==${RESET}`);
}

export function info(msg) {
  console.log(`  ${msg}`);
}

export function ok(msg) {
  console.log(`  ${GREEN}ok${RESET} ${msg}`);
}

export function warn(msg) {
  console.error(`  ${YELLOW}warn${RESET} ${msg}`);
}

export function die(msg) {
  console.error(`  ${RED}error${RESET} ${msg}`);
  process.exit(1);
}

export function problem(ctx, msg) {
  if (ctx.dry) warn(`${msg} (dry run: continuing)`);
  else die(msg);
}
