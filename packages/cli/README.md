# preflight-interlock

`npx preflight-interlock` (the binary is `preflight`) runs the Preflight monitors offline: check one
Vonage call-control object against the federal and Georgia telemarketing rules, replay the labelled
corpus, or verify an evidence log from genesis. It carries no data tables and needs no account; number
facts are given on the command line.

```
preflight check object.json --declaration decl.json --from 14045550100 --line-type wireless --within-hours true
preflight replay corpus/ncco
preflight verify-ledger https://your-preflight-host
```

Exit codes: check 0 pass, 2 block, 3 hold; replay 0 when every label matches; verify-ledger 0 intact,
4 broken. Source, properties and citations: https://github.com/StephenSook/preflight
