import {isDesktop} from './platform';
export interface ArchivedDiagnostic { date: string; json: string }
let recent: ArchivedDiagnostic | null = null;
function openArchive(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('atssim-diagnostics',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('days');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(new Error('诊断存储被占用'));
  });
}
export async function archiveDiagnostics(entry: ArchivedDiagnostic): Promise<boolean> {
  recent=entry;
  let db: IDBDatabase | undefined;
  try {
    db=await openArchive();
    await new Promise<void>((resolve,reject)=>{const tx=db!.transaction('days','readwrite');tx.objectStore('days').put(entry,'previous');tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});
    return true;
  } catch { return false; } finally { db?.close(); }
}
export async function previousDiagnostics(): Promise<ArchivedDiagnostic|null> {
  if(recent)return recent;
  let db: IDBDatabase | undefined;
  try {
    db=await openArchive();
    return await new Promise((resolve,reject)=>{const tx=db!.transaction('days','readonly'),req=tx.objectStore('days').get('previous');tx.oncomplete=()=>resolve(req.result??null);tx.onabort=tx.onerror=()=>reject(tx.error);});
  } catch { return null; } finally { db?.close(); }
}
export async function downloadDiagnostics(json: string, filename: string): Promise<void> {
  if(isDesktop()) {
    const [{save},{writeTextFile}]=await Promise.all([import('@tauri-apps/plugin-dialog'),import('@tauri-apps/plugin-fs')]);
    const path=await save({defaultPath:filename,filters:[{name:'诊断 JSON',extensions:['json']}]});
    if(path)await writeTextFile(path,json);
    return;
  }
  const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
