import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * A yt-dlp stand-in that records each call's arguments, and the cookie jar it
 * was handed, in `directory`. `fail` echoes the jar's path and contents on
 * stderr, which is the only way real yt-dlp could name them, and
 * `sealJarDirectory` takes write permission off the jar's directory so the
 * caller's wipe of it fails the way a locked temporary area would.
 */
export async function writeCookieRecordingYtDlp(
  directory: string,
  options: {
    readonly download?: 'succeed' | 'fail' | 'hang'
    readonly sealJarDirectory?: boolean
  } = {},
): Promise<string> {
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const record = JSON.stringify(directory)
  await fs.writeFile(ytDlpPath, [
    `#!${process.execPath}`,
    "const fs=require('node:fs');const p=require('node:path');",
    // A caller reads these records from another process while this one runs,
    // and may quit the moment a record appears — taking this process group
    // down mid-write. So a record never exists under its final name until it is
    // whole: each is written beside its name and moved onto it by rename(2),
    // which is atomic. Watching for the name then observes the finished bytes
    // rather than the empty file an open(O_CREAT) leaves, which is the state
    // Linux reports to a directory watcher before a single byte is written.
    `const write=(n,d)=>{const f=p.join(${record},n);fs.writeFileSync(f+'.tmp',d);fs.renameSync(f+'.tmp',f)};`,
    "const a=process.argv.slice(2);",
    "const call=a.includes('--simulate')?'metadata':'download';",
    "write(call+'-args.json',JSON.stringify(a));",
    "const c=a.indexOf('--cookies');const jar=c<0?undefined:a[c+1];",
    "if(jar)write(call+'-jar.json',JSON.stringify({path:jar,mode:fs.statSync(jar).mode&0o777,contents:fs.readFileSync(jar,'utf8')}));",
    options.sealJarDirectory ? "if(jar)fs.chmodSync(p.dirname(jar),0o500);" : '',
    "if(call==='metadata'){process.stdout.write(JSON.stringify({filesize:5,duration:2}));process.exit(0)}",
    options.download === 'fail'
      ? "process.stderr.write('ERROR: '+(jar?jar+' '+fs.readFileSync(jar,'utf8'):'no cookie jar')+' was rejected');process.exit(1);"
      : options.download === 'hang'
        ? 'setInterval(()=>{},1000);'
        : "fs.writeFileSync(a[a.indexOf('-o')+1],'video');",
    '',
  ].join('\n'))
  await fs.chmod(ytDlpPath, 0o700)
  return ytDlpPath
}

/** An ffprobe stand-in that describes the five bytes the yt-dlp stub writes. */
export async function writeMediaProbe(directory: string): Promise<string> {
  const ffprobePath = path.join(directory, 'ffprobe.cjs')
  await fs.writeFile(ffprobePath, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({format:{duration:'2',size:'5',format_name:'mp4'},streams:[{codec_type:'video',width:640,height:360},{codec_type:'audio'}]}));\n`)
  await fs.chmod(ffprobePath, 0o700)
  return ffprobePath
}
