// Builds docs/index.html (GitHub Pages) from todo-app/public/index.html:
// same UI, but the fetch()-based api() is swapped for a localStorage implementation.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "todo-app/public/index.html"), "utf8");

const SHIM = String.raw`// ---- API (static build: data lives in this browser's localStorage) ----
const LS_KEY="doyu-todo-v2";
const DEF_CATS=[
  {n:"업무",dot:"#8FAEFF",bg:"#E3EBFF",tx:"#3C5BC4"},
  {n:"개인",dot:"#FF9DB5",bg:"#FFE4EB",tx:"#C24468"},
  {n:"공부",dot:"#7DD3A8",bg:"#DDF4E8",tx:"#2A8659"},
  {n:"운동",dot:"#FFBE5C",bg:"#FFEED2",tx:"#B26F0A"}];
class ApiError extends Error{constructor(status,msg,data){super(msg);this.status=status;this.data=data||{}}}
function lsLoad(){
  try{const d=JSON.parse(localStorage.getItem(LS_KEY));if(d&&Array.isArray(d.cats))return d}catch(e){}
  return {cats:DEF_CATS.map(c=>({...c})),todos:[],monthly:{},seq:1};
}
function lsSave(d){
  try{localStorage.setItem(LS_KEY,JSON.stringify(d))}
  catch(e){throw new ApiError(500,"브라우저 저장소를 사용할 수 없어요 (시크릿 모드이거나 저장이 차단됨)")}
}
const clone=x=>JSON.parse(JSON.stringify(x));
const RE_DATE=/^\d{4}-\d{2}-\d{2}$/,RE_MONTH=/^\d{4}-\d{2}$/,RE_HEX=/^#[0-9a-fA-F]{6}$/;
const need=(v,name,max)=>{if(typeof v!=="string"||!v.trim())throw new ApiError(400,name+"을(를) 입력하세요");if(v.trim().length>max)throw new ApiError(400,name+"은(는) "+max+"자 이하여야 해요");return v.trim()};
function readDl(dl){
  if(!dl)return null;
  if(!RE_DATE.test(dl.date||"")||isNaN(Date.parse(dl.date)))throw new ApiError(400,"마감일이 올바르지 않아요");
  return {date:dl.date,label:String(dl.label||"").trim().slice(0,4)};
}
function readRp(r,start,hasDl){
  if(!r)return null;
  if(hasDl)throw new ApiError(400,"반복 일정에는 마감일을 함께 설정할 수 없어요");
  if(!["daily","weekly","monthly"].includes(r.type))throw new ApiError(400,"반복 종류가 올바르지 않아요");
  let days=[];
  if(r.type==="weekly"){
    if(!Array.isArray(r.days))throw new ApiError(400,"반복할 요일을 선택하세요");
    days=[...new Set(r.days)].sort();
    if(!days.length||days.some(x=>!Number.isInteger(x)||x<0||x>6))throw new ApiError(400,"반복할 요일을 선택하세요");
  }
  let until=null;
  if(r.until){
    if(!RE_DATE.test(r.until)||isNaN(Date.parse(r.until)))throw new ApiError(400,"반복 종료일이 올바르지 않아요");
    if(r.until<start)throw new ApiError(400,"종료일은 시작일 이후여야 해요");
    until=r.until;
  }
  return {type:r.type,days,until};
}
async function api(method,url,body){
  body=body||{};
  const d=lsLoad(),u=new URL(url,"http://x"),p=u.pathname;let m;
  const hasCat=n=>d.cats.some(c=>c.n===n);
  const catOk=n=>{if(!hasCat(n))throw new ApiError(400,"존재하지 않는 카테고리예요");return n};
  const find=(arr,id)=>{const t=arr.find(x=>x.id===+id);if(!t)throw new ApiError(404,"할 일을 찾을 수 없어요");return t};
  if(method==="GET"&&p==="/api/state")return clone({cats:d.cats,todos:d.todos,monthly:d.monthly});

  if(method==="POST"&&p==="/api/categories"){
    const n=need(body.name,"카테고리 이름",12);
    for(const k of ["dot","bg","tx"])if(!RE_HEX.test(body[k]||""))throw new ApiError(400,"색상 형식이 올바르지 않아요");
    if(hasCat(n))throw new ApiError(409,"이미 있는 카테고리예요");
    const c={n,dot:body.dot,bg:body.bg,tx:body.tx};d.cats.push(c);lsSave(d);return clone(c);
  }
  if(method==="PATCH"&&(m=p.match(/^\/api\/categories\/([^/]+)$/))){
    const old=decodeURIComponent(m[1]),c=d.cats.find(x=>x.n===old);
    if(!c)throw new ApiError(404,"카테고리를 찾을 수 없어요");
    const n=need(body.name,"카테고리 이름",12);
    if(n!==old){
      if(hasCat(n))throw new ApiError(409,"이미 있는 카테고리예요");
      c.n=n;d.todos.forEach(t=>{if(t.cat===old)t.cat=n});
      for(const k of Object.keys(d.monthly))d.monthly[k].forEach(t=>{if(t.cat===old)t.cat=n});
    }
    lsSave(d);return clone(c);
  }
  if(method==="DELETE"&&(m=p.match(/^\/api\/categories\/([^/]+)$/))){
    const n=decodeURIComponent(m[1]);
    if(!hasCat(n))throw new ApiError(404,"카테고리를 찾을 수 없어요");
    if(d.cats.length<=1)throw new ApiError(400,"카테고리는 최소 1개 있어야 해요");
    const used=d.todos.filter(t=>t.cat===n).length+Object.values(d.monthly).flat().filter(t=>t.cat===n).length;
    if(used&&u.searchParams.get("cascade")!=="1")throw new ApiError(409,"이 카테고리의 할 일이 "+used+"개 있어요",{used});
    d.todos=d.todos.filter(t=>t.cat!==n);
    for(const k of Object.keys(d.monthly))d.monthly[k]=d.monthly[k].filter(t=>t.cat!==n);
    d.cats=d.cats.filter(c=>c.n!==n);lsSave(d);return null;
  }

  if(method==="POST"&&p==="/api/todos"){
    const text=need(body.text,"할 일",200);
    if(!RE_DATE.test(body.date||"")||isNaN(Date.parse(body.date)))throw new ApiError(400,"날짜가 올바르지 않아요");
    const cat=catOk(body.cat),dl=readDl(body.dl),repeat=readRp(body.repeat,body.date,!!dl);
    const t={id:d.seq++,date:body.date,text,cat,done:false,dl,repeat,doneDates:[],skipDates:[]};d.todos.push(t);lsSave(d);return clone(t);
  }
  if(method==="POST"&&p==="/api/monthly"){
    const text=need(body.text,"할 일",200);
    if(!RE_MONTH.test(body.month||""))throw new ApiError(400,"월 형식이 올바르지 않아요");
    const t={id:d.seq++,month:body.month,text,cat:catOk(body.cat),done:false};
    (d.monthly[body.month]=d.monthly[body.month]||[]).push(t);lsSave(d);return clone(t);
  }
  if(method==="PATCH"&&(m=p.match(/^\/api\/todos\/(\d+)$/))){
    const t=find(d.todos,m[1]);
    if(body.skip!==undefined){
      if(!t.repeat)throw new ApiError(400,"반복 일정만 건너뛸 수 있어요");
      if(!RE_DATE.test(body.date||"")||isNaN(Date.parse(body.date)))throw new ApiError(400,"건너뛸 날짜가 필요해요");
      const set=new Set(t.skipDates||[]);body.skip?set.add(body.date):set.delete(body.date);t.skipDates=[...set].sort();
    }
    if(body.text!==undefined)t.text=need(body.text,"할 일",200);
    if(body.done!==undefined){
      if(t.repeat){
        if(!RE_DATE.test(body.date||"")||isNaN(Date.parse(body.date)))throw new ApiError(400,"반복 일정은 완료할 날짜가 필요해요");
        const set=new Set(t.doneDates||[]);body.done?set.add(body.date):set.delete(body.date);t.doneDates=[...set].sort();
      }else t.done=!!body.done;
    }
    if(body.cat!==undefined)t.cat=catOk(body.cat);
    if("dl" in body||"repeat" in body){
      const dl="dl" in body?readDl(body.dl):(t.dl||null);
      const repeat="repeat" in body?readRp(body.repeat,t.date,!!dl):(t.repeat||null);
      if(dl&&repeat)throw new ApiError(400,"반복 일정에는 마감일을 함께 설정할 수 없어요");
      if(t.repeat&&!repeat){t.doneDates=[];t.skipDates=[]}
      t.dl=dl;t.repeat=repeat;
    }
    lsSave(d);return clone(t);
  }
  if(method==="PATCH"&&(m=p.match(/^\/api\/monthly\/(\d+)$/))){
    const t=find(Object.values(d.monthly).flat(),m[1]);
    if(body.text!==undefined)t.text=need(body.text,"할 일",200);
    if(body.done!==undefined)t.done=!!body.done;
    if(body.cat!==undefined)t.cat=catOk(body.cat);
    lsSave(d);return clone(t);
  }
  if(method==="DELETE"&&(m=p.match(/^\/api\/todos\/(\d+)$/))){
    find(d.todos,m[1]);d.todos=d.todos.filter(t=>t.id!==+m[1]);lsSave(d);return null;
  }
  if(method==="DELETE"&&(m=p.match(/^\/api\/monthly\/(\d+)$/))){
    find(Object.values(d.monthly).flat(),m[1]);
    for(const k of Object.keys(d.monthly))d.monthly[k]=d.monthly[k].filter(t=>t.id!==+m[1]);
    lsSave(d);return null;
  }
  throw new ApiError(404,"not found");
}
`;

const a = src.indexOf("// ---- API ----"), b = src.indexOf("let toastT;");
if (a < 0 || b < a) throw new Error("API block markers not found in todo-app/public/index.html");
let out = src.slice(0, a) + SHIM + src.slice(b);
out = out.replace("</body>", '<p style="text-align:center;color:#8a8f98;font-size:12px;margin:32px 0 0">이 버전은 데이터가 이 브라우저에만 저장돼요 (기기·브라우저가 바뀌면 보이지 않아요)</p>\n</body>');
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/index.html"), out);
fs.writeFileSync(path.join(root, "docs/.nojekyll"), "");
console.log("built docs/index.html (" + out.length + " bytes)");
