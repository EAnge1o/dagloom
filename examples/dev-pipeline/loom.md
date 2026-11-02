# 🧵 dev-pipeline — a pure-shell dagloom demo

A runnable demo with no agent CLIs required. Four fake stages are woven into
a DAG: install fans out to build and lint, test waits for both, report gates
on a real output file. Delete the `.loom/` directory to watch the flaky task
retry from scratch.

    dagloom graph
    dagloom run
    dagloom show

## loom

concurrency: 4
fail_fast: false

## install

Pretend to install dependencies (takes ~1.5s).

cmd: node -e "setTimeout(()=>console.log('install: ok'),1500)"

## build

Pretend to compile (~1s). Only needs install.

depends: install
cmd: node -e "setTimeout(()=>console.log('build: ok'),1000)"

## lint

Runs in parallel with build — nothing here needs the build output.

depends: install
cmd: node -e "setTimeout(()=>console.log('lint: clean'),600)"

## test

Flaky on purpose: fails the first attempt, passes on the retry.
Watch dagloom back off exponentially (1s, then 2s).

depends: build, lint
retry: 2
backoff: 1
cmd: node -e "const fs=require('fs');let n=0;try{n=JSON.parse(fs.readFileSync('.loom/.flaky','utf8')).n}catch{};n++;fs.mkdirSync('.loom',{recursive:true});fs.writeFileSync('.loom/.flaky',JSON.stringify({n}));if(n<2){console.error('flake! attempt '+n);process.exit(1)}console.log('test: green on attempt '+n)"

## report

Writes an artifact, and dagloom refuses to call this done unless the file
actually exists (outputs gate).

depends: test
cmd: node -e "require('fs').writeFileSync('.loom/report.txt','all green')"
outputs: .loom/report.txt
