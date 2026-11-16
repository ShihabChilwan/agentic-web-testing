#!/bin/bash
# noise from golden, golden-2, golden-3 (responses and pages), then compare every other execution with golden
set -e
r=$1
cd /workspaces/agentic-web-testing
read -r g g2 g3 g4 <<<"$(node -e "const m=require('./runs/$r/eval/mapping.json'); const g=v=>m.versions.find(x=>x.version===v).execId; console.log(['golden','golden-2','golden-3','golden-4'].map(g).join(' '))")"
npx tsx src/cli.ts agent noise --run $r --execs $g,$g2,$g3 --page-execs $g,$g2,$g3 2>&1 | tail -2
for x in $(node -e "const m=require('./runs/$r/eval/mapping.json'); console.log(m.versions.filter(v=>v.version!=='golden'&&v.version!=='golden-2'&&v.version!=='golden-3').map(v=>v.execId).join(' '))"); do
  npx tsx src/cli.ts agent compare --run $r --base $g --other $x > /dev/null 2>&1 || echo "compare $x FAILED"
done
ls runs/$r/differential | wc -l
