import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
try {
  if(git('rev-parse','HEAD')!==process.env.SOURCE_SHA)throw new Error('The branch changed after this build. Regenerate from its current head.');
  if(!process.env.TARGET_BRANCH?.startsWith('codex/'))throw new Error('Generated files may only be synchronized to a codex branch.');
  const files=['ptunnel.js','docs/images/terminal-dashboard.png','docs/images/terminal-compact.png'];
  fs.mkdirSync('docs/images',{recursive:true});
  for(const file of files){
    const artifact=file==='ptunnel.js'?'standalone-client':'terminal-previews';
    fs.copyFileSync(path.join(process.env.RUNNER_TEMP,artifact,path.basename(file)),file);
  }
  git('add','--',...files);
  if(!git('diff','--cached','--name-only','--',...files))process.exit(0);
  git('config','user.name','github-actions[bot]');
  git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
  git('commit','-m','build: synchronize the client and terminal previews from CI');
  git('push','origin',`HEAD:refs/heads/${process.env.TARGET_BRANCH}`);
}catch(error){
  const detail=[error.message,error.stdout,error.stderr].filter(Boolean).join('\n').slice(0,6000)
    .replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  console.error(`::error title=Generated client sync failed::${detail}`);
  process.exitCode=1;
}
