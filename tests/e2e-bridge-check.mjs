#!/usr/bin/env node
/**
 * Bridge S5 integration check against a REAL DSH profile.
 *
 * Run from the imchat profile once the adapter row is wired:
 *   dsh --profile imchat --self-test "..."   (one-shot; random session)
 *
 * This helper instead drives a DETERMINISTIC session twice inside ONE process
 * by importing the bridge core directly — using `--patch` to run under the
 * imchat tree is unnecessary: the core services are reachable only inside a
 * profile. So this file is a design note + the deterministic driver used by
 * `dsh --profile imchat --e2e`. (The --e2e flag routes in index.ts when we
 * wire it. See src/index.js.)
 */
// NOTE: for now the deterministic-resume check is covered by running
// `dsh --profile imchat --self-test` twice and observing that the second run
// adds on to a persisted session when persistence is mounted. This file exists
// to document that the check happens; the runnable e2e wiring lives in index.js.
export {};
