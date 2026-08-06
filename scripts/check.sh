#!/usr/bin/env bash
# Everything that must hold before a change is considered done.
#   ./scripts/check.sh
# Exits non-zero on the first failure. No dependencies beyond node + curl.

set -uo pipefail
cd "$(dirname "$0")/.."

fails=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fails=$((fails+1)); }

step "1. syntax"
for f in server.js scripts/warm.js public/app.js public/matcher.mjs test/scoring.test.mjs test/photos.test.js; do
  if node --check "$f" 2>/dev/null; then ok "$f"; else bad "$f does not parse"; fi
done

step "2. matcher module loads and exports the scorers"
# The matcher is a real ES module now (public/matcher.mjs), imported by app.js
# and the tests — no more string-slice/eval hack. Guard that its exports exist.
node -e '
import("./public/matcher.mjs").then(m=>{
  const names=["norm","key","lev","wordMatch","scored","best","indexNames","scoreBinomial","scoreCommon"];
  const missing=names.filter(n=>typeof m[n]==="undefined");
  if(missing.length){console.error("  FAIL  matcher.mjs missing exports: "+missing.join(", "));process.exit(1)}
  console.log("  ok    matcher.mjs exports "+names.join(", "));
}).catch(e=>{console.error("  FAIL  matcher.mjs did not load: "+e.message);process.exit(1)})
' || fails=$((fails+1))

step "3. scoring tests"
if out=$(node test/scoring.test.mjs 2>&1); then
  ok "$(printf '%s' "$out" | grep -c '^ok') assertions pass"
else
  printf '%s\n' "$out" | grep -E '^FAIL|FAILURE' | sed 's/^/  /'
  bad "scoring tests"
fi
if out=$(node test/photos.test.js 2>&1); then
  ok "$(printf '%s' "$out" | grep -c '^ok') photo-selection assertions pass"
else
  printf '%s\n' "$out" | grep -E '^FAIL|FAILURE' | sed 's/^/  /'
  bad "photo-selection tests"
fi

step "4. dataset"
node -e '
const T=require("./data/taxa.json");
let bad=0;
const chk=(c,m)=>{ if(!c) bad++; console.log((c?"  ok    ":"  FAIL  ")+m); };
chk(T.length===500, T.length+" taxa");
chk(new Set(T.map(t=>t.id)).size===T.length, "ids unique");
chk(T.every(t=>t.sci&&t.common&&t.habit&&t.family), "no empty fields");
chk(T.filter(t=>t.genusOnly).length===60, "60 genus-only taxa");
process.exit(bad?1:0);
' || fails=$((fails+1))

step "5. DOM contract"
# Every id app.js queries with $("#...") must exist in index.html, unless
# app.js creates it itself. Drift here fails silently at runtime.
node -e '
const fs=require("fs");
const app=fs.readFileSync("public/app.js","utf8"), html=fs.readFileSync("public/index.html","utf8");
const q=new Set([...app.matchAll(/\$\(.#([A-Za-z0-9_-]+).\)/g)].map(m=>m[1]));
const inHtml=new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m=>m[1]));
const made=new Set([...app.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m=>m[1]));
const missing=[...q].filter(id=>!inHtml.has(id)&&!made.has(id));
if(missing.length){console.error("  FAIL  queried but never created: "+missing.join(", "));process.exit(1)}
console.log("  ok    "+q.size+" queried ids all accounted for");
' || fails=$((fails+1))

step "6. server smoke test"
PORT_T=$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
OFFLINE=1 PORT="$PORT_T" node server.js >/tmp/check-srv.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1.5

hit() { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$PORT_T$1"; }
[ "$(hit /)" = 200 ]            && ok "GET /" || bad "GET / returned $(hit /)"
[ "$(hit /app.js)" = 200 ]      && ok "GET /app.js" || bad "GET /app.js"
# app.js is an ES module and imports matcher.mjs; the browser refuses a module
# served with the wrong MIME, so check both status and content type.
[ "$(hit /matcher.mjs)" = 200 ] && ok "GET /matcher.mjs" || bad "GET /matcher.mjs"
mjs_ct=$(curl -s -o /dev/null -w '%{content_type}' --max-time 4 "http://127.0.0.1:$PORT_T/matcher.mjs")
case "$mjs_ct" in *javascript*) ok "matcher.mjs served as javascript" ;; *) bad "matcher.mjs MIME is '$mjs_ct' (browser will refuse the module)" ;; esac
[ "$(hit /styles.css)" = 200 ]  && ok "GET /styles.css" || bad "GET /styles.css"
n=$(curl -s --max-time 4 "http://127.0.0.1:$PORT_T/api/taxa" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')
[ "$n" = 500 ] && ok "GET /api/taxa -> 500" || bad "GET /api/taxa -> $n"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 -X PUT -H 'Content-Type: application/json' \
  -d '{"cards":{}}' "http://127.0.0.1:$PORT_T/api/state/_checkrun")
[ "$code" = 200 ] && ok "PUT /api/state" || bad "PUT /api/state -> $code"
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 -X PUT -d 'nope' "http://127.0.0.1:$PORT_T/api/state/_checkrun")" = 400 ] \
  && ok "PUT rejects malformed JSON" || bad "PUT should reject malformed JSON with 400"

kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
rm -f data/states/_checkrun.json
if grep -qi 'warning' /tmp/check-srv.log; then
  bad "server emitted warnings:"; grep -i warning /tmp/check-srv.log | head -3 | sed 's/^/        /'
else
  ok "no node warnings"
fi

step "7. warm.js does not bind a port"
# server.js must stay behind require.main === module, or warming inside a
# running container dies with EADDRINUSE.
if grep -q 'require.main === module' server.js; then ok "listen() is guarded"; else bad "server.js calls listen() on import"; fi

step "8. answer-check wiring cannot leak a click event into 'skipped'"
# `elem.onclick = fn` calls fn(event); binding doCheck bare made a MouseEvent
# arrive as `skipped`, scoring every typed answer as blank 0/2. Two guards must
# both hold: doCheck coerces skipped to a strict boolean, and #check is bound
# through a wrapper rather than the bare reference.
if grep -Eq 'skipped *= *skipped *=== *true' public/app.js; then ok "doCheck coerces skipped to boolean"; else bad "doCheck no longer coerces skipped === true"; fi
if grep -Eq "\\\$\('#check'\)\.onclick *= *doCheck *;" public/app.js; then bad "#check binds bare doCheck; a click leaks the event as skipped"; else ok "#check binding does not pass the click event"; fi

printf '\n'
if [ "$fails" -eq 0 ]; then printf '\033[32mall checks pass\033[0m\n'; else printf '\033[31m%s check(s) failed\033[0m\n' "$fails"; fi
exit "$fails"
