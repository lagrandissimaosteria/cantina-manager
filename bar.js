/* bar.js — Modulo BAR: spirits & amari, birre, sodati.
   Identico per tutti i locali. Dipende da manager.js (ORD_CAT, orders, _sb,
   _effectiveDbUser, _merge3, _lsKey, h, fmt, fmtN, today, uid, notify, ic, render).
   Dati: blob cm_bar (user_id, data jsonb[]) — record misti, tutti con id:
     t:"p" prodotto   {key,cat,nome,produttore,formato,tipo,unita,dosi,prezzo,costo,attivo}
     t:"m" movimento  {data,pid,tipo:"auto"|"vend",causale,qty(unità di vendita),note}
     t:"c" conta      {data,pid,pezzi}
   Carichi: DERIVATI dagli ordini di categoria bar con stato "caricato".
   Modello: consumo reale = giacenza iniziale + carichi − giacenza finale (conte).
   Uscite non registrate = consumo − autoconsumo − vendite registrate:
   senza export di cassa è il venduto stimato; con le vendite registrate è l'ammanco. */
"use strict";
var bar = [], _barBase = [], _barTableOk = true;
var barUi = { tab:"riepilogo", per:"mese", da:"", a:"", cat:"tutte", q:"", contaData:"" };
const BAR_CAUSALI = ["Staff","Omaggio cliente","Cucina","Rottura / perdita","Degustazione","Altro"];
const BAR_UNITA = { dose:"Dose", bicchiere:"Bicchiere", bottiglia:"Bottiglia", pezzo:"Pezzo" };

// ─── Persistenza (stesso pattern di cm_fatture) ──────────────────────────────
async function _barRead(){
  if(!_sb) return { _missing:true };
  try{
    const { data, error } = await _sb.from("cm_bar").select("data").eq("user_id", _effectiveDbUser());
    if(error){ _barTableOk=false; return { _missing:true }; }
    _barTableOk=true;
    return (data&&data[0]&&data[0].data) || [];
  }catch{ _barTableOk=false; return { _missing:true }; }
}
function _barCache(){ try{ localStorage.setItem(_lsKey("bar"), JSON.stringify(bar)); }catch{} }
async function _loadBar(){
  const r = await _barRead();
  let loc = []; try{ loc = JSON.parse(localStorage.getItem(_lsKey("bar"))||"[]"); }catch{}
  if(r && r._missing) bar = Array.isArray(loc)?loc:[];
  else if(!r.length && Array.isArray(loc) && loc.length){ bar = loc; _barBase=[]; await _barSave(true); }
  else bar = r;
  _barBase = JSON.parse(JSON.stringify(bar));
}
async function _rebaseBar(){
  const r = await _barRead();
  if(r && !r._missing && Array.isArray(r)){ bar = _merge3(_barBase, bar, r); _barBase = JSON.parse(JSON.stringify(bar)); }
}
async function _barSave(skipRebase){
  _barCache();
  if(!_sb || !_barTableOk) return;
  try{
    if(!skipRebase) await _rebaseBar();
    const { error } = await _sb.from("cm_bar").upsert(
      { user_id:_effectiveDbUser(), data:JSON.parse(JSON.stringify(bar)), updated_at:new Date().toISOString() },
      { onConflict:"user_id" });
    if(error){ notify("Bar: salvataggio cloud non riuscito, dati tenuti in locale","err"); return; }
    _barBase = JSON.parse(JSON.stringify(bar)); _barCache();
  }catch{ notify("Bar: rete assente, dati tenuti in locale","err"); }
}

// ─── Anagrafica: prodotti salvati + scoperti dagli ordini ────────────────────
const _barNorm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," ").trim();
const _barKey = (prod,nome,formato) => `${_barNorm(prod)}|${_barNorm(nome)}|${parseFloat(formato)||0}`;
function _barDefaults(cat, tipo, formato){
  const f = parseFloat(formato)||0;
  if(cat==="spirits") return { unita:"dose", dosi: f? Math.round(f/0.04*10)/10 : 17.5 };
  if(tipo==="Fusto" || (cat==="birre" && f>=5)) return { unita:"bicchiere", dosi: f? Math.round(f/0.4*10)/10 : 50 };
  if(cat==="birre") return { unita:"bottiglia", dosi:1 };
  return { unita:"pezzo", dosi:1 };
}
// Carichi da ordini bar caricati: [{key,data,pezzi,costoTot,fornitore,ref,cat}]
function _barCarichi(){
  const out = [];
  (orders||[]).forEach(o=>{
    const cat = _ordCat(o); if(!cat || o.stato!=="caricato") return;
    const sc = parseFloat(o.sconto)||0, data = o.dataArrivo||o.dataOrdine||"";
    (o.referenze||[]).forEach(r=>{
      const q = parseInt(r.qtyArr ?? r.qty)||0; if(q<=0) return;
      const unit = (parseFloat(r.prezzoAcq)||0)*(1+(parseInt(r.iva)||22)/100)*(1-(parseFloat(r.scontoRef)||0)/100)*(1-sc/100);
      out.push({ key:_barKey(r.produttore,r.nomeVino,r.formato), data, pezzi:q, costoTot:unit*q, fornitore:o.fornitore||"", ref:r, cat });
    });
  });
  return out;
}
// Unisce: record salvati (override) + prodotti scoperti dagli ordini. Ritorna array prodotti "vivi".
function _barProdotti(){
  const car = _barCarichi(), saved = bar.filter(x=>x.t==="p"), byKey = new Map(saved.map(p=>[p.key,p]));
  const agg = new Map();
  car.forEach(c=>{
    const a = agg.get(c.key) || { pezzi:0, costo:0, fornitori:new Set(), ref:c.ref, cat:c.cat, ultimo:"" };
    a.pezzi+=c.pezzi; a.costo+=c.costoTot; if(c.fornitore) a.fornitori.add(c.fornitore);
    if(c.data>=a.ultimo){ a.ultimo=c.data; a.ref=c.ref; a.cat=c.cat; }
    agg.set(c.key, a);
  });
  const res = [];
  const mk = (key, p, a) => {
    const ref = a?.ref || {}, cat = p?.cat || a?.cat || "spirits";
    const tipo = p?.tipo || ref.tipologia || "", formato = p?.formato ?? ref.formato ?? 0;
    const d = _barDefaults(cat, tipo, formato);
    return {
      id: p?.id || "auto:"+key, saved: !!p, key, cat, tipo, formato,
      nome: p?.nome || ref.nomeVino || "", produttore: p?.produttore ?? ref.produttore ?? "",
      fornitore: p?.fornitore || (a? [...a.fornitori].join(", ") : ""),
      unita: p?.unita || d.unita, dosi: parseFloat(p?.dosi) || d.dosi, prezzo: parseFloat(p?.prezzo)||0,
      costo: parseFloat(p?.costo) || (a&&a.pezzi? a.costo/a.pezzi : 0), // costo medio ponderato a pezzo, IVA incl.
      attivo: p ? p.attivo!==false : true
    };
  };
  saved.forEach(p=>res.push(mk(p.key, p, agg.get(p.key))));
  agg.forEach((a,k)=>{ if(!byKey.has(k)) res.push(mk(k, null, a)); });
  return res.sort((x,y)=>(x.cat+x.tipo+x.nome).localeCompare(y.cat+y.tipo+y.nome,"it"));
}
// Materializza un prodotto scoperto (serve un id stabile per movimenti/conte)
function _barEnsure(p){
  if(p.saved) return p.id;
  const rec = { id:uid(), t:"p", key:p.key, cat:p.cat, nome:p.nome, produttore:p.produttore, formato:p.formato,
    tipo:p.tipo, unita:p.unita, dosi:p.dosi, prezzo:p.prezzo, costo:0, attivo:true };
  bar.push(rec); return rec.id;
}

// ─── Calcoli ─────────────────────────────────────────────────────────────────
function _barPrevDay(d){ const x=new Date(d+"T00:00:00"); x.setDate(x.getDate()-1); return _isoDate(x); }
function _barRange(){
  const t = today(), y = t.slice(0,4), ym = t.slice(0,7);
  if(barUi.per==="mese") return [ym+"-01", t];
  if(barUi.per==="mesescorso"){ const d=new Date(ym+"-01T00:00:00"); d.setDate(0); const e=_isoDate(d); return [e.slice(0,7)+"-01", e]; }
  if(barUi.per==="anno") return [y+"-01-01", t];
  return [barUi.da||ym+"-01", barUi.a||t];
}
// Giacenza (pezzi) a fine giornata D. idx = indici precalcolati per prodotto.
function _barGiac(ix, D){
  let base = 0, from = "";
  for(const c of ix.conte) if(c.data<=D && c.data>=from){ base = parseFloat(c.pezzi)||0; from = c.data; }
  const after = d => from ? d>from : true;
  let g = base;
  ix.car.forEach(c=>{ if(c.data<=D && after(c.data)) g+=c.pezzi; });
  ix.mov.forEach(m=>{ if(m.data<=D && after(m.data)) g-=(parseFloat(m.qty)||0)/ix.dosi; });
  return { g, conta: from };
}
function _barIndex(prods){
  const car = _barCarichi(), byId = new Map(prods.map(p=>[p.id,p])), byKey = new Map(prods.map(p=>[p.key,p]));
  const ix = new Map(prods.map(p=>[p.id,{ p, dosi:p.dosi||1, car:[], mov:[], conte:[] }]));
  car.forEach(c=>{ const p=byKey.get(c.key); if(p) ix.get(p.id).car.push(c); });
  bar.forEach(x=>{ if((x.t==="m"||x.t==="c") && byId.has(x.pid)) ix.get(x.pid)[x.t==="m"?"mov":"conte"].push(x); });
  return ix;
}
function _barStats(da, a){
  const prods = _barProdotti(), ix = _barIndex(prods), pre = _barPrevDay(da), rows = [];
  ix.forEach(i=>{
    const p = i.p; if(barUi.cat!=="tutte" && p.cat!==barUi.cat) return;
    const gi = _barGiac(i, pre), gf = _barGiac(i, a);
    const carP = i.car.filter(c=>c.data>=da&&c.data<=a), car = carP.reduce((s,c)=>s+c.pezzi,0), acq = carP.reduce((s,c)=>s+c.costoTot,0);
    const mv = i.mov.filter(m=>m.data>=da&&m.data<=a);
    const auto = mv.filter(m=>m.tipo==="auto").reduce((s,m)=>s+(parseFloat(m.qty)||0),0)/i.dosi;
    const vend = mv.filter(m=>m.tipo==="vend").reduce((s,m)=>s+(parseFloat(m.qty)||0),0)/i.dosi;
    const consumo = gi.g + car - gf.g;
    const nonReg = consumo - auto - vend;
    if(!car && !auto && !vend && Math.abs(consumo)<1e-9 && Math.abs(gf.g)<1e-9) return;
    rows.push({ p, gi:gi.g, gf:gf.g, contaFin:gf.conta, car, acq, auto, vend, consumo, nonReg,
      cConsumo: consumo*p.costo, cAuto: auto*p.costo,
      ricavo: (vend + Math.max(0,nonReg)) * p.dosi * p.prezzo,
      valFin: Math.max(0,gf.g)*p.costo });
  });
  return rows;
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function _barCatLbl(k){ return ORD_CAT[k]?.label || k; }
function _barCatDot(k){ return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${ORD_CAT[k]?.color||"var(--txt4)"};margin-right:6px"></span>`; }
const _barPz = n => fmtN(n, Math.abs(n%1)<1e-9?0:1);
function barSet(k,v){ barUi[k]=v; render(); }

function renderBar(){
  const tabs = [["riepilogo","Riepilogo"],["registra","Autoconsumo & vendite"],["conta","Conta inventario"],["prodotti","Prodotti"]];
  let html = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${tabs.map(([k,l])=>
    `<button class="${barUi.tab===k?"btn-primary":"btn-outline"} btn-sm" onclick="barSet('tab','${k}')">${l}</button>`).join("")}</div>`;
  if(!_barTableOk) html += `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--orange);font-size:12px;color:var(--txt2)">${ic("alert")} Tabella <code>cm_bar</code> non raggiungibile: i dati restano solo su questo computer.</div>`;
  const catSel = `<div><label class="form-label">Categoria</label><select class="form-select" onchange="barSet('cat',this.value)">
    <option value="tutte">Tutte</option>${Object.entries(ORD_CAT).map(([k,c])=>`<option value="${k}" ${barUi.cat===k?"selected":""}>${h(c.label)}</option>`).join("")}</select></div>`;
  if(barUi.tab==="riepilogo") html += _barRiepilogo(catSel);
  else if(barUi.tab==="registra") html += _barRegistra();
  else if(barUi.tab==="conta") html += _barConta(catSel);
  else html += _barProdottiUi(catSel);
  return html;
}

function _barRiepilogo(catSel){
  const [da,a] = _barRange(), rows = _barStats(da,a);
  const S = k => rows.reduce((s,r)=>s+r[k],0);
  const acq=S("acq"), cCons=S("cConsumo"), cAuto=S("cAuto"), ric=S("ricavo"), valFin=S("valFin");
  const cVend = cCons - cAuto, inc = ric? cVend/ric*100 : 0;
  const nonRegPz = rows.reduce((s,r)=>s+Math.max(0,r.nonReg),0), vendReg = S("vend");
  const senzaConta = rows.filter(r=>!r.contaFin || r.contaFin<a).length;
  const kpi=(l,v,col,sub)=>`<div class="card" style="padding:14px"><div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">${l}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:1.4rem;color:${col}">${v}</div><div style="font-size:12px;color:var(--txt4);margin-top:4px">${sub}</div></div>`;
  let html = `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">
    <div><label class="form-label">Periodo</label><select class="form-select" onchange="barSet('per',this.value)">
      ${[["mese","Mese corrente"],["mesescorso","Mese scorso"],["anno","Anno"],["custom","Personalizzato"]].map(([k,l])=>`<option value="${k}" ${barUi.per===k?"selected":""}>${l}</option>`).join("")}</select></div>
    ${barUi.per==="custom"?`<div><label class="form-label">Dal</label><input type="date" class="form-input" value="${da}" onchange="barSet('da',this.value)"></div>
    <div><label class="form-label">Al</label><input type="date" class="form-input" value="${a}" onchange="barSet('a',this.value)"></div>`:""}
    ${catSel}</div></div>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px">
    ${kpi("Acquisti", fmt(acq), "var(--txt)", "ordini caricati nel periodo")}
    ${kpi("Consumo a costo", fmt(cCons), "var(--txt)", "giac. iniziale + carichi − giac. finale")}
    ${kpi("Autoconsumo", fmt(cAuto), cAuto>0?"var(--orange)":"var(--txt3)", cCons? `${fmtN(cAuto/cCons*100,1)}% del consumo`:"—")}
    ${kpi("Ricavo stimato", fmt(ric), "var(--green)", vendReg? "vendite registrate + non registrate":"per differenza dalle conte")}
    ${kpi("Incidenza costo", ric? fmtN(inc,1)+"%":"—", inc>30?"var(--red)":"var(--txt)", "costo venduto / ricavo")}
    ${kpi("Valore giacenza", fmt(valFin), "var(--txt)", "a costo, fine periodo")}
  </div>`;
  if(senzaConta && rows.length) html += `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--orange);font-size:12px;color:var(--txt2)">${ic("alert")}
    ${senzaConta} prodott${senzaConta===1?"o":"i"} senza conta al ${a.split("-").reverse().join("/")}: per loro la giacenza finale è teorica e il consumo reale coincide con quanto registrato. Fai una conta a fine periodo per avere il dato vero.</div>`;
  if(vendReg && nonRegPz>0.01) html += `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--red);font-size:12px;color:var(--txt2)">${ic("alert")}
    Uscite non registrate: ${_barPz(nonRegPz)} pezzi. Se registri tutte le vendite dalla cassa, questo è l'ammanco.</div>`;
  // Per categoria
  const cats = Object.keys(ORD_CAT).filter(k=>rows.some(r=>r.p.cat===k));
  if(cats.length) html += `<div class="card" style="margin-bottom:16px"><div class="card-header"><span>${ic("chart")} Per categoria</span><span style="font-size:11px;color:var(--txt4)">IVA incl.</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:var(--txt4);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
    <td style="padding:8px 14px">Categoria</td><td style="text-align:right;padding:8px">Acquisti</td><td style="text-align:right;padding:8px">Consumo</td><td style="text-align:right;padding:8px">Autoconsumo</td><td style="text-align:right;padding:8px">%</td><td style="text-align:right;padding:8px 14px">Ricavo stimato</td></tr></thead><tbody>
    ${cats.map(k=>{ const rr=rows.filter(r=>r.p.cat===k), s=f=>rr.reduce((x,r)=>x+r[f],0), cc=s("cConsumo"), ca=s("cAuto");
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 14px">${_barCatDot(k)}${h(_barCatLbl(k))}</td><td style="text-align:right;padding:6px 8px">${fmt(s("acq"))}</td>
      <td style="text-align:right;padding:6px 8px">${fmt(cc)}</td><td style="text-align:right;padding:6px 8px">${fmt(ca)}</td><td style="text-align:right;padding:6px 8px;color:var(--txt3)">${cc?fmtN(ca/cc*100,0)+"%":"—"}</td>
      <td style="text-align:right;padding:6px 14px">${fmt(s("ricavo"))}</td></tr>`; }).join("")}</tbody></table></div>`;
  // Per prodotto
  const th = (l,al) => `<th style="padding:8px;text-align:${al||"right"};font-size:11px;color:var(--txt4);font-weight:500;text-transform:uppercase;letter-spacing:.04em">${l}</th>`;
  html += `<div class="card" style="overflow-x:auto"><div class="card-header"><span>${ic("bottle")} Per prodotto</span><span style="font-size:11px;color:var(--txt4)">quantità in pezzi (bottiglie / fusti / lattine)</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:900px"><thead><tr>${th("Prodotto","left")}${th("Giac. iniz.")}${th("Carichi")}${th("Giac. fin.")}${th("Consumo")}${th("Autocons.")}${th("Vend. reg.")}${th("Non reg.")}${th("Costo consumo")}${th("Autocons. €")}${th("Ricavo stim.")}</tr></thead><tbody>
    ${rows.length? rows.sort((x,y)=>y.cConsumo-x.cConsumo).map(r=>`<tr style="border-top:1px solid var(--border)">
      <td style="padding:6px 8px">${_barCatDot(r.p.cat)}${h(r.p.nome)}${r.p.produttore?` <span style="color:var(--txt4)">· ${h(r.p.produttore)}</span>`:""}${r.contaFin?"":` <span style="color:var(--orange);font-size:10px">teorica</span>`}${!r.p.prezzo?` <span style="color:var(--red);font-size:10px">senza prezzo</span>`:""}</td>
      <td style="text-align:right;padding:6px 8px">${_barPz(r.gi)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.car)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.gf)}</td>
      <td style="text-align:right;padding:6px 8px">${_barPz(r.consumo)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.auto)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.vend)}</td>
      <td style="text-align:right;padding:6px 8px;color:${r.nonReg<-0.01?"var(--red)":"var(--txt2)"}">${_barPz(r.nonReg)}</td>
      <td style="text-align:right;padding:6px 8px">${fmt(r.cConsumo)}</td><td style="text-align:right;padding:6px 8px">${fmt(r.cAuto)}</td><td style="text-align:right;padding:6px 8px">${fmt(r.ricavo)}</td></tr>`).join("")
      : `<tr><td colspan="11" style="padding:20px;text-align:center;color:var(--txt4)">Nessun movimento nel periodo. I prodotti compaiono quando un ordine Spirits, Birre o Sodati viene caricato.</td></tr>`}
    </tbody></table></div>`;
  return html;
}

function _barRegistra(){
  const prods = _barProdotti().filter(p=>p.attivo);
  const opts = prods.map(p=>`<option value="${h(p.id)}">${h(_barCatLbl(p.cat))} — ${h(p.nome)}${p.produttore?" · "+h(p.produttore):""} (${BAR_UNITA[p.unita]||p.unita})</option>`).join("");
  const movs = bar.filter(x=>x.t==="m").sort((x,y)=>(y.data+y.ts||"").localeCompare(x.data+x.ts||"")).slice(0,60);
  const pById = new Map(prods.map(p=>[p.id,p])); _barProdotti().forEach(p=>pById.set(p.id,p));
  return `<div class="card" style="margin-bottom:16px"><div class="card-header"><span>${ic("plus")} Registra uscita</span><span style="font-size:11px;color:var(--txt4)">quantità in unità di vendita (dosi, bicchieri, bottiglie)</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">
      <div><label class="form-label">Data</label><input type="date" id="bar-m-data" class="form-input" value="${today()}"></div>
      <div style="grid-column:span 2"><label class="form-label">Prodotto</label><select id="bar-m-pid" class="form-select">${opts||`<option value="">Nessun prodotto</option>`}</select></div>
      <div><label class="form-label">Tipo</label><select id="bar-m-tipo" class="form-select" onchange="document.getElementById('bar-m-caus-w').style.display=this.value==='auto'?'':'none'">
        <option value="auto">Autoconsumo</option><option value="vend">Vendita (da cassa)</option></select></div>
      <div id="bar-m-caus-w"><label class="form-label">Causale</label><select id="bar-m-caus" class="form-select">${BAR_CAUSALI.map(c=>`<option>${h(c)}</option>`).join("")}</select></div>
      <div><label class="form-label">Quantità</label><input type="number" id="bar-m-qty" class="form-input" min="0" step="0.5" value="1"></div>
      <div><label class="form-label">Note</label><input id="bar-m-note" class="form-input"></div>
      <div><button class="btn-primary" onclick="barAddMov()">Registra</button></div>
    </div></div>
    <div class="card" style="overflow-x:auto"><div class="card-header"><span>${ic("clipboard")} Ultime registrazioni</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
    ${movs.length? movs.map(m=>{ const p=pById.get(m.pid); const v=p?(parseFloat(m.qty)||0)/(p.dosi||1)*p.costo:0;
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px;white-space:nowrap">${m.data.split("-").reverse().join("/")}</td>
      <td style="padding:6px 8px">${m.tipo==="auto"?`<span style="color:var(--orange)">Autoconsumo</span> · ${h(m.causale||"")}`:`<span style="color:var(--green)">Vendita</span>`}</td>
      <td style="padding:6px 8px">${p?h(p.nome):"<i>prodotto rimosso</i>"}</td><td style="padding:6px 8px;text-align:right">${fmtN(parseFloat(m.qty)||0,1)} ${p?h((BAR_UNITA[p.unita]||"").toLowerCase()):""}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--txt3)">${fmt(v)}</td><td style="padding:6px 8px;color:var(--txt4)">${h(m.note||"")}</td>
      <td style="padding:6px 8px;text-align:right"><button class="btn-outline btn-sm" onclick="barDel('${m.id}')">${ic("trash")}</button></td></tr>`; }).join("")
      : `<tr><td style="padding:20px;text-align:center;color:var(--txt4)">Nessuna registrazione.</td></tr>`}
    </tbody></table></div>`;
}
async function barAddMov(){
  const sel = document.getElementById("bar-m-pid").value, qty = parseFloat(document.getElementById("bar-m-qty").value)||0;
  if(!sel){ notify("Scegli un prodotto","err"); return; }
  if(qty<=0){ notify("Quantità non valida","err"); return; }
  const p = _barProdotti().find(x=>x.id===sel); if(!p) return;
  const pid = _barEnsure(p), tipo = document.getElementById("bar-m-tipo").value;
  bar.push({ id:uid(), t:"m", ts:Date.now(), data:document.getElementById("bar-m-data").value||today(), pid, tipo,
    causale: tipo==="auto"? document.getElementById("bar-m-caus").value : "", qty, note:(document.getElementById("bar-m-note").value||"").trim() });
  render(); notify(tipo==="auto"?"Autoconsumo registrato":"Vendita registrata");
  await _barSave(); if(section==="bar") render();
}
async function barDel(id){
  if(!confirm("Eliminare la registrazione?")) return;
  bar = bar.filter(x=>x.id!==id); render(); await _barSave(); if(section==="bar") render();
}

function _barConta(catSel){
  const D = barUi.contaData || today();
  const prods = _barProdotti().filter(p=>p.attivo && (barUi.cat==="tutte"||p.cat===barUi.cat)), ix = _barIndex(prods);
  const esist = new Map(bar.filter(x=>x.t==="c"&&x.data===D).map(c=>[c.pid,c]));
  const storico = [...bar.filter(x=>x.t==="c").reduce((m,c)=>m.set(c.data,(m.get(c.data)||0)+1),new Map())].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,24);
  return `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">
      <div><label class="form-label">Data conta (fine giornata)</label><input type="date" class="form-input" value="${D}" onchange="barSet('contaData',this.value)"></div>${catSel}
      <div><button class="btn-primary" onclick="barSalvaConta()">Salva conta</button></div></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">Conta i pezzi fisici: bottiglie aperte a frazione (0,25 · 0,5 · 0,75). Lascia vuoto ciò che non hai contato. Il valore grigio è la giacenza teorica.</div></div>
    <div class="card" style="overflow-x:auto;margin-bottom:16px"><table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>
    ${prods.length? prods.map(p=>{ const i=ix.get(p.id), teo=_barGiac(i,D).g, c=esist.get(p.saved?p.id:"");
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px">${_barCatDot(p.cat)}${h(p.nome)}${p.produttore?` <span style="color:var(--txt4)">· ${h(p.produttore)}</span>`:""}${p.formato?` <span style="color:var(--txt4)">${fmtN(parseFloat(p.formato),2)} L</span>`:""}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--txt4);white-space:nowrap">teorica ${_barPz(teo)}</td>
      <td style="padding:6px 8px;width:110px"><input type="number" class="form-input bar-conta" data-pid="${h(p.id)}" min="0" step="0.25" value="${c?c.pezzi:""}" placeholder="${_barPz(Math.max(0,teo))}"></td></tr>`; }).join("")
      : `<tr><td style="padding:20px;text-align:center;color:var(--txt4)">Nessun prodotto.</td></tr>`}
    </tbody></table></div>
    ${storico.length?`<div class="card"><div class="card-header"><span>${ic("calendar")} Conte salvate</span></div><div style="display:flex;flex-wrap:wrap;gap:8px">
      ${storico.map(([d,n])=>`<span class="btn-outline btn-sm" style="display:inline-flex;gap:8px;align-items:center"><a href="#" onclick="barSet('contaData','${d}');return false" style="color:inherit">${d.split("-").reverse().join("/")} · ${n}</a>
      <a href="#" title="Elimina conta" onclick="barDelConta('${d}');return false" style="color:var(--red)">${ic("x")}</a></span>`).join("")}</div></div>`:""}`;
}
async function barSalvaConta(){
  const D = barUi.contaData || today(), prods = _barProdotti(); let n = 0;
  document.querySelectorAll(".bar-conta").forEach(inp=>{
    if(inp.value==="") return;
    const v = parseFloat(inp.value); if(isNaN(v)||v<0) return;
    const p = prods.find(x=>x.id===inp.dataset.pid); if(!p) return;
    const pid = _barEnsure(p);
    const ex = bar.find(x=>x.t==="c"&&x.pid===pid&&x.data===D);
    if(ex) ex.pezzi = v; else bar.push({ id:uid(), t:"c", data:D, pid, pezzi:v });
    n++;
  });
  if(!n){ notify("Nessuna quantità inserita","err"); return; }
  notify(`Conta salvata: ${n} prodott${n===1?"o":"i"}`); render(); await _barSave(); if(section==="bar") render();
}
async function barDelConta(d){
  if(!confirm(`Eliminare la conta del ${d.split("-").reverse().join("/")}?`)) return;
  bar = bar.filter(x=>!(x.t==="c"&&x.data===d)); render(); await _barSave(); if(section==="bar") render();
}

function _barProdottiUi(catSel){
  const prods = _barProdotti().filter(p=>(barUi.cat==="tutte"||p.cat===barUi.cat) && (!barUi.q || _barNorm(p.nome+" "+p.produttore+" "+p.fornitore).includes(_barNorm(barUi.q))));
  const ix = _barIndex(prods), t = today();
  const th = (l,al) => `<th style="padding:8px;text-align:${al||"left"};font-size:11px;color:var(--txt4);font-weight:500;text-transform:uppercase;letter-spacing:.04em">${l}</th>`;
  const inp = (p,f,v,step,w) => `<input type="number" class="form-input" style="width:${w||80}px;padding:4px 6px" min="0" step="${step}" value="${v||""}" onchange="barSetProd('${h(p.id)}','${f}',this.value)">`;
  return `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">
      ${catSel}<div><label class="form-label">Cerca</label><input class="form-input" value="${h(barUi.q)}" onchange="barSet('q',this.value)" placeholder="nome, produttore, fornitore"></div>
      <div><button class="btn-outline btn-sm" onclick="barNuovoProd()">+ Prodotto non ordinato</button></div></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">I prodotti arrivano dagli ordini caricati. Imposta unità di vendita, quante unità escono da un pezzo e il prezzo di vendita (IVA incl.). Il costo è la media ponderata degli acquisti; scrivilo solo per sovrascriverlo.</div></div>
    <div class="card" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:980px"><thead><tr>
      ${th("Prodotto")}${th("Fornitore")}${th("Unità vendita")}${th("Unità/pezzo")}${th("Prezzo unità")}${th("Costo pezzo")}${th("Costo unità","right")}${th("Margine","right")}${th("Giacenza","right")}${th("")}</tr></thead><tbody>
    ${prods.map(p=>{ const cu = p.dosi? p.costo/p.dosi : 0, mg = p.prezzo? (1-cu/p.prezzo)*100 : null;
      return `<tr style="border-top:1px solid var(--border);${p.attivo?"":"opacity:.45"}">
      <td style="padding:6px 8px">${_barCatDot(p.cat)}${h(p.nome)}${p.produttore?` <span style="color:var(--txt4)">· ${h(p.produttore)}</span>`:""}<div style="font-size:11px;color:var(--txt4)">${h(p.tipo||"")}${p.formato?` · ${fmtN(parseFloat(p.formato),2)} L`:""}</div></td>
      <td style="padding:6px 8px;color:var(--txt3)">${h(p.fornitore||"—")}</td>
      <td style="padding:6px 8px"><select class="form-select" style="width:120px;padding:4px 6px" onchange="barSetProd('${h(p.id)}','unita',this.value)">${Object.entries(BAR_UNITA).map(([k,l])=>`<option value="${k}" ${p.unita===k?"selected":""}>${l}</option>`).join("")}</select></td>
      <td style="padding:6px 8px">${inp(p,"dosi",p.dosi,"0.5",70)}</td><td style="padding:6px 8px">${inp(p,"prezzo",p.prezzo,"0.5",80)}</td>
      <td style="padding:6px 8px">${inp(p,"costo",p.saved&&bar.find(x=>x.id===p.id)?.costo||"","0.01",80)}<div style="font-size:10px;color:var(--txt4)">${fmt(p.costo)}</div></td>
      <td style="padding:6px 8px;text-align:right">${fmt(cu)}</td>
      <td style="padding:6px 8px;text-align:right;color:${mg===null?"var(--txt4)":mg<65?"var(--orange)":"var(--green)"}">${mg===null?"—":fmtN(mg,0)+"%"}</td>
      <td style="padding:6px 8px;text-align:right">${_barPz(_barGiac(ix.get(p.id),t).g)}</td>
      <td style="padding:6px 8px;text-align:right"><button class="btn-outline btn-sm" title="${p.attivo?"Nascondi dalle liste":"Riattiva"}" onclick="barSetProd('${h(p.id)}','attivo',${!p.attivo})">${p.attivo?ic("eye"):ic("refresh")}</button></td></tr>`; }).join("")
      || `<tr><td colspan="10" style="padding:20px;text-align:center;color:var(--txt4)">Nessun prodotto. Carica un ordine Spirits, Birre o Sodati oppure aggiungilo a mano.</td></tr>`}
    </tbody></table></div>`;
}
async function barSetProd(id, f, v){
  let p = _barProdotti().find(x=>x.id===id); if(!p) return;
  const wasSaved = p.saved, pid = _barEnsure(p), rec = bar.find(x=>x.id===pid);
  if(f==="unita"){ rec.unita = v; const d=_barDefaults(rec.cat, rec.tipo, rec.formato); if(v===d.unita) rec.dosi=d.dosi; else if(v==="bottiglia"||v==="pezzo") rec.dosi=1; }
  else if(f==="attivo") rec.attivo = !!v;
  else rec[f] = Math.max(0, parseFloat(v)||0);
  // Campi numerici su prodotto già salvato: niente re-render (non si perde il fuoco col Tab)
  if(!wasSaved || f==="unita" || f==="attivo") render();
  await _barSave();
}
async function barNuovoProd(){
  const cat = (prompt("Categoria: spirits, birre o sodati","spirits")||"").trim().toLowerCase();
  if(!ORD_CAT[cat]){ if(cat) notify("Categoria non valida","err"); return; }
  const nome = (prompt("Nome prodotto")||"").trim(); if(!nome) return;
  const produttore = (prompt("Produttore (facoltativo)")||"").trim();
  const formato = parseFloat(String(prompt("Formato in litri (es. 0.7, 0.33, 20)","0.7")||"").replace(",","."))||0;
  const tipo = ORD_CAT[cat].tipi[0], d = _barDefaults(cat, tipo, formato);
  const key = _barKey(produttore, nome, formato);
  if(bar.some(x=>x.t==="p"&&x.key===key) || _barCarichi().some(c=>c.key===key)){ notify("Prodotto già presente","err"); return; }
  bar.push({ id:uid(), t:"p", key, cat, nome, produttore, formato, tipo, unita:d.unita, dosi:d.dosi, prezzo:0, costo:0, attivo:true });
  render(); await _barSave();
}
