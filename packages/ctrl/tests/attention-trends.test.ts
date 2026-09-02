// attention-trends.test.ts — GET /api/v1/attention/trends (#584).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atrends-"));
process.env.ALFRED_DATA_DIR   = tmp;
process.env.STATE_DB_PATH     = path.join(tmp, "state.db");
process.env.VAULT_PATH        = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH   = "";
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state");
["needs_attention","decision","event"].forEach(d=>fs.mkdirSync(path.join(tmp,"vault",d),{recursive:true}));

const { getStateDb }          = await import("../src/db/state.js");
const { registerStateRoutes } = await import("../src/api/routes/state.js");
const { registerAttentionRoutes, periodKeyBounds } = await import("../src/api/routes/attention.js");
const { matchRoute }          = await import("../src/api/server.js");

registerStateRoutes();
registerAttentionRoutes();
const db = getStateDb();

async function getTrends(qs:string):Promise<{status:number;p:any}> {
  const m=matchRoute("GET","/api/v1/attention/trends"); assert.ok(m);
  let status=0; let p:any={};
  const res={writeHead(s:number){status=s;return res;},end(j?:string){if(j)p=JSON.parse(j);}} as unknown as ServerResponse;
  try { await m.handler({req:{}as any,res,params:{},body:null,query:new URLSearchParams(qs)}); }
  catch(e:any){if(typeof e?.statusCode==="number"){status=e.statusCode;p={error:e.message};}else throw e;}
  return {status,p};
}

let _seq=0;
function nar(ov:Record<string,unknown>={}) {
  _seq++;
  db.prepare(`INSERT OR REPLACE INTO nar_entry(id,dedup_key,occurred_at,action_class,summary,evidence_kind,evidence_ref,estimation_method,displaced_minutes,acceptance,acceptance_path,notes)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`01TRN${String(_seq).padStart(21,"0")}`,`trn-${_seq}`,ov.occurred_at??"2026-08-10T10:00:00Z",
      ov.action_class??"conversational","test",ov.evidence_kind??"session",`ref-${_seq}`,
      "standard-time",ov.displaced_minutes??10,"accepted","inferred",ov.notes??null);
}
function jrn(ts:string,dir="outbound"){
  db.prepare(`INSERT INTO alfred_journal(id,ts,channel,chat_id,direction,message)VALUES(?,?,?,?,?,?)`)
    .run(`jrn-${++_seq}`,ts,"telegram","test",dir,"msg");
}
function clear(){
  db.prepare("DELETE FROM nar_entry").run();
  db.prepare("DELETE FROM alfred_journal").run();
  db.prepare("DELETE FROM observation").run();
}
/** Insert a fake attention_read observation for the given window. */
function obs(grain:string,from:string,to:string,observations:unknown[]=[],generated_at="2026-08-10T00:00:00.000000+00:00"){
  _seq++;
  db.prepare(`INSERT INTO observation(id,ts,subject,kind,summary,confidence,status,payload_json)VALUES(?,?,?,?,?,?,?,?)`)
    .run(`01OBS${String(_seq).padStart(21,"0")}`,generated_at,
      `attention_trend:${grain}:${from}:${to}`,"attention_read","summary",1.0,"open",
      JSON.stringify({grain,from,to,observations,generated_at,period_count:0}));
}

// 1. periodKeyBounds helper — keys and boundaries for all three grains
describe("periodKeyBounds",()=>{
  it("week 2026-08-10 (Monday) → W33, Mon 08-10 – Sun 08-16",()=>{
    const b=periodKeyBounds("week","2026-08-10");
    assert.strictEqual(b.key,"2026-W33");assert.strictEqual(b.start,"2026-08-10");assert.strictEqual(b.end,"2026-08-16");
  });
  it("month 2026-08-15 → 2026-08, 01–31; Feb 2026 ends 28 (non-leap)",()=>{
    const m=periodKeyBounds("month","2026-08-15");
    assert.strictEqual(m.key,"2026-08");assert.strictEqual(m.start,"2026-08-01");assert.strictEqual(m.end,"2026-08-31");
    assert.strictEqual(periodKeyBounds("month","2026-02-15").end,"2026-02-28");
  });
  it("quarter 2026-08-01 → Q3, 07-01–09-30",()=>{
    const q=periodKeyBounds("quarter","2026-08-01");
    assert.strictEqual(q.key,"2026-Q3");assert.strictEqual(q.start,"2026-07-01");assert.strictEqual(q.end,"2026-09-30");
  });
});

// 2. Partial periods — real days count, canonical boundaries preserved
describe("partial period",()=>{
  beforeEach(clear);
  it("month 5 days in Aug → days=5, canonical start/end",async()=>{
    const {status,p}=await getTrends("grain=month&from=2026-08-25&to=2026-08-29");
    assert.strictEqual(status,200);assert.strictEqual(p.periods[0].days,5);
    assert.strictEqual(p.periods[0].start,"2026-08-01");assert.strictEqual(p.periods[0].end,"2026-08-31");
  });
  it("quarter Jun28-Jul03 → Q2(3d)+Q3(3d)",async()=>{
    const {status,p}=await getTrends("grain=quarter&from=2026-06-28&to=2026-07-03");
    assert.strictEqual(status,200);assert.strictEqual(p.periods.length,2);
    assert.strictEqual(p.periods[0].key,"2026-Q2");assert.strictEqual(p.periods[0].days,3);
    assert.strictEqual(p.periods[1].key,"2026-Q3");assert.strictEqual(p.periods[1].days,3);
  });
});

// 3. return_ratio null when engaged=0
describe("coverage.data_from",()=>{
  it("reports the earliest ledger entry overall, not window-bound",async()=>{
    clear();
    nar({occurred_at:"2026-05-23T09:00:00Z"});           // earliest, outside window
    nar({occurred_at:"2026-08-11T09:00:00Z"});
    const {status,p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.equal(status,200);
    // The pickers need the floor of selectable periods; a window-bound MIN
    // would hide history the user can legitimately compare against.
    assert.equal(p.coverage.data_from,"2026-05-23");
  });
  it("null on an empty ledger — pickers fall back, never crash",async()=>{
    clear();
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.equal(p.coverage.data_from,null);
  });
});

describe("return_ratio",()=>{
  beforeEach(clear);
  it("null (not Infinity) when engaged_hours=0",async()=>{
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-10");
    assert.strictEqual(p.periods[0].engaged_hours,0);
    assert.strictEqual(p.periods[0].return_ratio,null);
  });
});

// 4. interruption_instrumented
describe("interruption_instrumented",()=>{
  beforeEach(clear);
  it("false when only inbound journal rows exist",async()=>{
    jrn("2026-08-12T14:00:00Z","inbound");
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.strictEqual(p.periods[0].interruption_instrumented,false);
  });
  it("true when at least one outbound row exists",async()=>{
    jrn("2026-08-12T14:00:00Z","outbound");
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.strictEqual(p.periods[0].interruption_instrumented,true);
  });
});

// 5. allocation + by_class displaced sums equal period.displaced_hours
describe("sum consistency",()=>{
  beforeEach(clear);
  it("alloc work+life+unallocated == displaced_hours; class sums too",async()=>{
    nar({occurred_at:"2026-08-10T09:00:00Z",displaced_minutes:30,notes:JSON.stringify({allocation:"work"})});
    nar({occurred_at:"2026-08-11T09:00:00Z",displaced_minutes:20,notes:JSON.stringify({allocation:"life"})});
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    const per=p.periods[0];
    const allocSum=per.allocation.work.displaced_hours+per.allocation.life.displaced_hours+per.allocation.unallocated.displaced_hours;
    assert.ok(Math.abs(allocSum-per.displaced_hours)<0.001,`alloc ${allocSum}≠${per.displaced_hours}`);
    const classSum=per.by_class.conversational.displaced_hours+per.by_class.autonomous.displaced_hours+per.by_class.explicit.displaced_hours;
    assert.ok(Math.abs(classSum-per.displaced_hours)<0.001,`class ${classSum}≠${per.displaced_hours}`);
  });
});

// 6. absent notes.outcome → unknown, not failed
describe("outcome classification",()=>{
  beforeEach(clear);
  it("delivered/failed/absent-null each count correctly; absent is unknown",async()=>{
    nar({occurred_at:"2026-08-10T09:00:00Z",notes:JSON.stringify({outcome:"delivered"})});
    nar({occurred_at:"2026-08-10T10:00:00Z",notes:JSON.stringify({outcome:"failed"})});
    nar({occurred_at:"2026-08-10T11:00:00Z",notes:null});
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-10");
    assert.deepStrictEqual(p.periods[0].outcomes,{delivered:1,failed:1,unknown:1});
  });
});

// 7. 400-day range cap
describe("400-day cap",()=>{
  it("401 days → 400",async()=>{
    const {status}=await getTrends("grain=month&from=2025-01-01&to=2026-02-05");
    assert.strictEqual(status,400);
  });
  it("400 days → 200",async()=>{
    const {status}=await getTrends("grain=month&from=2025-01-01&to=2026-02-04");
    assert.strictEqual(status,200);
  });
});

// 8. read field — joins attention_read observation for the exact window
describe("read field",()=>{
  beforeEach(clear);
  it("null when no observation exists for this window",async()=>{
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.strictEqual(p.read,null);
  });
  it("returns generated_at + observations array when a matching obs exists",async()=>{
    const obsList=[{headline:"Return ratio fell",detail:"From 1.4 to 0.9.",evidence:"return_ratio=0.9"}];
    obs("week","2026-08-10","2026-08-16",obsList,"2026-08-11T02:00:00.000000+00:00");
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.ok(p.read,"read should not be null");
    assert.strictEqual(p.read.generated_at,"2026-08-11T02:00:00.000000+00:00");
    assert.deepStrictEqual(p.read.observations,obsList);
  });
  it("returns [] (not null) when a matching obs exists with empty observations",async()=>{
    obs("week","2026-08-10","2026-08-16",[],"2026-08-11T02:00:00.000000+00:00");
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.ok(p.read!==null,"read must not be null — workflow ran, found nothing");
    assert.deepStrictEqual(p.read.observations,[]);
  });
  it("null when obs exists for different grain (month vs week)",async()=>{
    obs("month","2026-08-01","2026-08-31",[{headline:"H"}]);
    const {p}=await getTrends("grain=week&from=2026-08-01&to=2026-08-07");
    assert.strictEqual(p.read,null);
  });
  it("null when obs exists for different date range",async()=>{
    obs("week","2026-08-03","2026-08-09",[{headline:"H"}]);
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-16");
    assert.strictEqual(p.read,null);
  });
});

// 9. by_bucket / unbucketed — "none" must not appear as a size tier
describe("by_bucket and unbucketed",()=>{
  beforeEach(clear);
  it("items with bucket='none' land in unbucketed, not by_bucket",async()=>{
    nar({occurred_at:"2026-08-10T09:00:00Z",displaced_minutes:12,notes:JSON.stringify({bucket:"none"})});
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-10");
    const per=p.periods[0];
    assert.ok(!("none" in per.by_bucket),"by_bucket must not contain 'none'");
    assert.strictEqual(per.unbucketed.count,1);
    assert.ok(per.unbucketed.displaced_hours>0);
  });
  it("items with no bucket also land in unbucketed",async()=>{
    nar({occurred_at:"2026-08-10T09:00:00Z",displaced_minutes:6,notes:JSON.stringify({allocation:"work"})});
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-10");
    const per=p.periods[0];
    assert.ok(!("none" in per.by_bucket));
    assert.strictEqual(per.unbucketed.count,1);
  });
  it("by_bucket displaced + unbucketed displaced equals total displaced",async()=>{
    nar({occurred_at:"2026-08-10T09:00:00Z",displaced_minutes:30,notes:JSON.stringify({bucket:"S"})});
    nar({occurred_at:"2026-08-10T10:00:00Z",displaced_minutes:20,notes:JSON.stringify({bucket:"none"})});
    nar({occurred_at:"2026-08-10T11:00:00Z",displaced_minutes:10,notes:null});
    const {p}=await getTrends("grain=week&from=2026-08-10&to=2026-08-10");
    const per=p.periods[0];
    const bktTotal=Object.values(per.by_bucket as Record<string,{displaced_hours:number}>).reduce((s,v)=>s+v.displaced_hours,0);
    const total=bktTotal+per.unbucketed.displaced_hours;
    assert.ok(Math.abs(total-per.displaced_hours)<0.001,
      `bkt(${bktTotal})+unbucketed(${per.unbucketed.displaced_hours})=${total} ≠ displaced(${per.displaced_hours})`);
  });
});

// ─── POST /api/v1/attention/trends/interpret (#584) ──────────────────────────
async function postInterpret(body:unknown):Promise<{status:number;p:any}> {
  const m=matchRoute("POST","/api/v1/attention/trends/interpret"); assert.ok(m);
  let status=0; let p:any={};
  const res={writeHead(s:number){status=s;return res;},end(j?:string){if(j)p=JSON.parse(j);}} as unknown as ServerResponse;
  try { await m.handler({req:{}as any,res,params:{},body,query:new URLSearchParams("")}); }
  catch(e:any){if(typeof e?.statusCode==="number"){status=e.statusCode;p={error:e.message};}else throw e;}
  return {status,p};
}

describe("POST /api/v1/attention/trends/interpret", () => {
  // The workflow TYPE string is the fragile part: ctrl starts a Temporal
  // workflow by name and learn registers it by name, in a different language,
  // with no shared constant. A mismatch does not error — Temporal accepts the
  // start, reports RUNNING, and the workflow task fails and retries forever.
  // That exact failure already cost this feature one silent debugging cycle.
  it("starts the workflow name learn actually registers", () => {
    const routeSrc = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "api", "routes", "attention.ts"), "utf8");
    // Slice from the interpret route so the NarDayRecapWorkflow start below
    // cannot satisfy this match; the source wraps lines, so match the type alone.
    const m = /"--type","([A-Za-z]+)"/.exec(
      routeSrc.slice(routeSrc.indexOf("trends/interpret")));
    assert.ok(m, "could not find the interpret route's workflow-start invocation");

    const wfSrc = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "learn", "src", "workflows",
                "attention_trend_read.py"), "utf8");
    const reg = /@workflow\.defn\(name="([A-Za-z]+)"\)/.exec(wfSrc);
    assert.ok(reg, "could not find @workflow.defn in attention_trend_read.py");

    assert.strictEqual(m![1], reg![1],
      `ctrl starts "${m![1]}" but learn registers "${reg![1]}" — a mismatch retries forever, silently`);
  });

  it("rejects a bad grain", async () => {
    const r = await postInterpret({grain:"fortnight",from:"2026-08-01",to:"2026-08-15"});
    assert.strictEqual(r.status, 400);
  });

  it("rejects a missing range", async () => {
    const r = await postInterpret({grain:"week",from:"2026-08-01"});
    assert.strictEqual(r.status, 400);
  });
});
