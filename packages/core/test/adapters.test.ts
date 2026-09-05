import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const page = window as any;
afterEach(() => {
 window.dispatchEvent(new Event("pagehide"));
 document.body.innerHTML = "";
 delete (document as any).modelContext;
 delete (SubmitEvent.prototype as any).respondWith;
 delete (SubmitEvent.prototype as any).agentInvoked;
 for (const key of ["__webDesktopMcpHost","__webDesktopMcp","__TAURI_INTERNALS__","go","runtime"]) delete page[key];
 vi.useRealTimers();
});

function load(kind: "tauri" | "wails", native = false, delayed = false) {
 const sent: any[] = [];
 let event: ((message: any) => void) | undefined;
 if (native) Object.defineProperty(document,"modelContext",{configurable:true,value:{registerTool:vi.fn(async()=>{})}});
 const receive = (m: any) => { if (kind==="tauri") page.__webDesktopMcpHost._deliver(m); else event?.(m); };
 const send = (m:any) => {
  sent.push(m);
  if(m.kind==="register") receive({kind:"registerResult",invocationId:m.invocationId,ok:true,_frameId:"main"});
  return Promise.resolve({ok:true});
 };
 const ready = () => {
  if(kind==="tauri") page.__TAURI_INTERNALS__={invoke:(_command:string,args:any)=>send(args.message)};
  else {
   page.runtime={WindowName:()=>"main",EventsOn:(_name:string,handler:any)=>{event=handler;return ()=>{event=undefined};}};
   page.go={webdesktopmcp:{Server:{Send:(_frame:string,m:any)=>send(m)}}};
  }
 };
 if(!delayed) ready();
 const path=kind==="tauri" ? "../../../crates/tauri-plugin-webdesktopmcp/src/bootstrap.js":"../../../go/webdesktopmcp/js/bootstrap.js";
 window.eval(readFileSync(new URL(path,import.meta.url),"utf8"));
 return {sent,receive,ready};
}

describe.each(["tauri","wails"] as const)("%s embedded bootstrap",kind=>{
 it("uses shared declarative form execution",async()=>{
  const host=load(kind);
  document.body.innerHTML='<form toolname="order" tooldescription="Order" toolautosubmit><input name="item" required><button>Go</button></form>';
  const form=document.querySelector("form")!;
  form.addEventListener("submit",(e:any)=>{e.preventDefault();e.respondWith({ordered:true});});
  await vi.waitFor(()=>expect(host.sent.some(m=>m.kind==="register"&&m.tool.name==="order")).toBe(true));
  host.receive({kind:"execute",invocationId:"inv-main-1",name:"order",input:{item:"pizza"},_frameId:"main"});
  await vi.waitFor(()=>expect(host.sent.find(m=>m.kind==="executeResult")).toMatchObject({ok:true,result:'{"ordered":true}'}));
  expect(form.querySelector("input")!.value).toBe("pizza");
 });
 it("preserves native registration exposure and lifetime",async()=>{
  const host=load(kind,true);
  const controller=new AbortController();
  await (document as any).modelContext.registerTool({name:"native",description:"Native tool",execute:async()=>1},{signal:controller.signal,exposedTo:["http://trusted"]});
  expect(host.sent.find(m=>m.kind==="register")).toMatchObject({exposedTo:["http://trusted"]});
  controller.abort();
  expect(host.sent.some(m=>m.kind==="unregister"&&m.name==="native")).toBe(true);
 });
 it("queues registration until transport is ready",async()=>{
  const host=load(kind,false,true);
  const promise=(document as any).modelContext.registerTool({name:"queued",description:"Queued",execute:async()=>1});
  host.ready();
  await promise;
  expect(host.sent.some(m=>m.kind==="register")).toBe(true);
 });
 it("rejects pending work when readiness times out",async()=>{
  vi.useFakeTimers();
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  load(kind,false,true);
  const registration=(document as any).modelContext.registerTool({name:"waiting",description:"Waiting",execute:async()=>1});
  const rejected=expect(registration).rejects.toMatchObject({name:"AbortError"});
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect((document as any).modelContext).toBeUndefined();
  log.mockRestore();
 });
 it("rejects pending work when native transport rejects",async()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  load(kind,false,true);
  if(kind==="tauri") page.__TAURI_INTERNALS__={invoke:()=>Promise.reject(new Error("IPC closed"))};
  else {
   page.runtime={EventsOn:()=>()=>{}};
   page.go={webdesktopmcp:{Server:{Send:()=>Promise.resolve({ok:false})}}};
  }
  const registration=(document as any).modelContext.registerTool({name:"failed",description:"Failed",execute:async()=>1});
  await expect(registration).rejects.toMatchObject({name:"AbortError"});
  log.mockRestore();
 });
 it("unregisters on pagehide",async()=>{
  const host=load(kind);
  await (document as any).modelContext.registerTool({name:"page",description:"Page",execute:async()=>1});
  window.dispatchEvent(new Event("pagehide"));
  expect(host.sent.some(m=>m.kind==="unregister"&&m.name==="page")).toBe(true);
 });
});
it("Wails ignores messages for other frames",async()=>{
 const host=load("wails");
 const execute=vi.fn(async()=>1);
 await (document as any).modelContext.registerTool({name:"local",description:"Local",execute});
 host.receive({kind:"execute",invocationId:"inv-main-1",name:"local",input:{},_frameId:"other"});
 await Promise.resolve();
 expect(execute).not.toHaveBeenCalled();
});
