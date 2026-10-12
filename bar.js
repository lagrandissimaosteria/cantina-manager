/* bar.js — Modulo BAR: spirits & amari, birre, sodati, polykeg, cocktail.
   Identico per tutti i locali (differenze solo da window.CM_CONFIG).
   Dipende da manager.js (ORD_CAT, orders, _sb, _effectiveDbUser, _merge3, _lsKey, h, fmt, fmtN,
   today, uid, notify, ic, render, apriOrdineModal, _newRef, _setOrdineCategoria, _ricRenderRighe).
   Dati: blob cm_bar (user_id, data jsonb[]) — record misti, tutti con id:
     t:"p" prodotto  {key,cat,nome,produttore,formato,tipo,unita,dosi(teoriche),dosecl,resa%,uso,prezzo,prezzoPiccola,costoNetto,scortaMin,attivo}
     t:"m" uscita    {data,pid,tipo:"auto"|"vend",causale,qty,taglia?,cl?,ric?,fonte?,lotto?,note}
     t:"c" conta     {data,pid,pezzi}
     t:"k" cocktail  {nome,prezzo,ingr:[{lbl,pid,cl}],extra(€ IVA escl.)}
   Carichi: DERIVATI dagli ordini bar "caricato". Gli ordini "attesa" mostrano il prodotto (in arrivo) ma non
   toccano giacenze né conte: niente doppie registrazioni alla ricezione.
   Modello a stime: consumo = giacenza iniziale + carichi − giacenza finale (conte settimanali).
   Ricavo: vendite da cassa (Tebi) se inserite, altrimenti stimato dal consumo × prezzo.
   Analisi (costi, ricavi, margini) SEMPRE IVA esclusa; la spesa acquisti è mostrata anche IVA inclusa. */
"use strict";
var bar = [], _barBase = [], _barTableOk = true;
var barUi = { tab:"riepilogo", per:"mese", da:"", a:"", cat:"tutte", q:"", contaData:"", cassaData:"" };
const BAR_CAUSALI = ["Staff","Omaggio cliente","Cucina","Rottura / perdita","Degustazione","Altro"];
// Opzioni per locale da window.CM_CONFIG: barFusti (false = niente spina/fusti), barPrezzi ({cat: € IVA incl.}),
// barSpina ({piccola:{cl,prezzo}, media:{cl,prezzo}}), ivaSomministrazione (% IVA sulle vendite, default 10)
const _barCfg = k => (typeof CONFIG!=="undefined" && CONFIG && CONFIG[k]!==undefined) ? CONFIG[k] : undefined;
const _barFusti = () => _barCfg("barFusti")!==false;
const _barPrezzoDef = cat => parseFloat((_barCfg("barPrezzi")||{})[cat])||0;
const _barSpina = () => { const s=_barCfg("barSpina"); return s&&s.media&&s.piccola? s : null; };
const _barIvaV = () => parseFloat(_barCfg("ivaSomministrazione"))||10;
const _barNet = lordo => (parseFloat(lordo)||0)/(1+_barIvaV()/100);   // prezzo di vendita → netto IVA
const _barTaglie = p => !!(_barSpina() && p && p.cat==="birre" && p.unita==="bicchiere");
const _barCock = p => p && (p.uso==="cocktail" || p.uso==="mixer");     // "mixer" = valore storico
const _barIsFusto = (unita, formato) => unita==="bicchiere" && (parseFloat(formato)||0)>=5;
const BAR_UNITA = { dose:"Dose", bicchiere:"Bicchiere", bottiglia:"Bottiglia", pezzo:"Pezzo" };
const BAR_SCHEDA = {
  spirits:{ prezzoLbl:"Prezzo dose", hint:"Dose servita in cl: le dosi per bottiglia si calcolano dal formato. \"Nei cocktail\" = la bottiglia si usa per i cocktail: il ricavo arriva dalle ricette.", contaHint:"bottiglie aperte a frazione (0,25 · 0,5 · 0,75)" },
  birre:{ prezzoLbl:"Prezzo", hint:"Spina: vendita a bicchiere (cl del bicchiere, la resa toglie schiuma e spurgo). Bottiglia/lattina: vendita a pezzo.", contaHint:"bottiglie e lattine intere, fusti aperti a frazione" },
  kegcocktail:{ prezzoLbl:"Prezzo bicchiere", hint:"Cocktail alla spina: cl serviti per bicchiere; la resa toglie le perdite del fusto.", contaHint:"fusti a frazione (0,25 · 0,5 · 0,75)" },
  kegvino:{ prezzoLbl:"Prezzo calice", hint:"Vino sfuso alla spina: cl del calice; la resa toglie le perdite del fusto.", contaHint:"fusti a frazione (0,25 · 0,5 · 0,75)" },
  sodati:{ prezzoLbl:"Prezzo pezzo", hint:"Vendita: prezzo al pezzo. \"Nei cocktail\": usato come mixer, il ricavo arriva dalle ricette.", contaHint:"pezzi interi" }
};
const _barDett = p => [p.tipo, p.eta, p.gradazione? String(p.gradazione).replace(".",",")+"% vol":"", p.formato? (typeof _ordFmtLabel==="function"? _ordFmtLabel(p.cat,p.formato) : fmtN(parseFloat(p.formato),2)+" L"):""].filter(Boolean).join(" · ");
const _barFmtD = d => d? d.split("-").reverse().join("/") : "";

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
  if(cat==="kegvino") return { unita:"bicchiere", dosecl:15, dosi: f? Math.round(f/0.15*10)/10 : 133.3 };
  if(cat==="kegcocktail") return { unita:"bicchiere", dosecl:12, dosi: f? Math.round(f/0.12*10)/10 : 166.7 };
  if(cat==="spirits") return { unita:"dose", dosecl:4, dosi: f? Math.round(f/0.04*10)/10 : 17.5 };
  if(_barFusti() && (tipo==="Fusto" || (cat==="birre" && f>=5))){ const cl=_barSpina()?.media.cl||40; return { unita:"bicchiere", dosecl:cl, dosi: f? Math.round(f*100/cl*10)/10 : 50 }; }
  if(cat==="birre") return { unita:"bottiglia", dosi:1 };
  return { unita:"pezzo", dosi:1 };
}
// Costo netto IVA di un pezzo da riga d'ordine (prezzoAcq è già IVA esclusa)
const _barUnitNet = (r,o) => (parseFloat(r.prezzoAcq)||0)*(1-(parseFloat(r.scontoRef)||0)/100)*(1-(parseFloat(o.sconto)||0)/100);
// Carichi da ordini bar caricati: [{key,data,pezzi,costoNet,costoLordo,fornitore,ref,cat}]
function _barCarichi(){
  const out = [];
  (orders||[]).forEach(o=>{
    const cat = _ordCat(o); if(!cat || o.stato!=="caricato") return;
    const data = o.dataArrivo||o.dataOrdine||"";
    (o.referenze||[]).forEach(r=>{
      const q = parseInt(r.qtyArr ?? r.qty)||0; if(q<=0) return;
      const net = _barUnitNet(r,o);
      out.push({ key:_barKey(r.produttore,r.nomeVino,r.formato), data, pezzi:q, costoNet:net*q, costoLordo:net*(1+(parseInt(r.iva)||22)/100)*q, fornitore:o.fornitore||"", ref:r, cat });
    });
  });
  return out;
}
// Unisce: record salvati (override) + prodotti scoperti dagli ordini (caricati e in arrivo).
function _barProdotti(){
  const car = _barCarichi(), saved = bar.filter(x=>x.t==="p"), byKey = new Map(saved.map(p=>[p.key,p]));
  const agg = new Map();
  car.forEach(c=>{
    const a = agg.get(c.key) || { pezzi:0, costo:0, fornitori:new Set(), ref:c.ref, cat:c.cat, ultimo:"" };
    a.pezzi+=c.pezzi; a.costo+=c.costoNet; if(c.fornitore) a.fornitori.add(c.fornitore);
    if(c.data>=a.ultimo){ a.ultimo=c.data; a.ref=c.ref; a.cat=c.cat; a.forn=c.fornitore; }
    agg.set(c.key, a);
  });
  // Ordini in attesa: il prodotto compare subito (in arrivo, costo stimato), ma NON entra in conte e uscite
  (orders||[]).forEach(o=>{
    const cat = _ordCat(o); if(!cat || o.stato!=="attesa") return;
    (o.referenze||[]).forEach(r=>{
      const key = _barKey(r.produttore,r.nomeVino,r.formato);
      if(agg.has(key)){ agg.get(key).inOrdine = true; return; }
      agg.set(key, { pezzi:0, costo:0, stima:_barUnitNet(r,o), pend:true, inOrdine:true, fornitori:new Set(o.fornitore?[o.fornitore]:[]), ref:r, cat, ultimo:"", forn:o.fornitore||"" });
    });
  });
  const res = [];
  const mk = (key, p, a) => {
    const ref = a?.ref || {}, cat = p?.cat || a?.cat || "spirits";
    const tipo = p?.tipo || ref.tipologia || "", formato = p?.formato ?? ref.formato ?? 0;
    const d = _barDefaults(cat, tipo, formato), unita = p?.unita || d.unita;
    const ivaAcq = parseInt(ref.iva)||22;
    const dosiTeo = parseFloat(p?.dosi) || d.dosi;
    const resa = parseFloat(p?.resa) || (_barIsFusto(unita, formato)? 90 : 100);
    // Costo netto IVA a pezzo: manuale (costoNetto; "costo" storico era IVA incl.) → media ordini → stima ordine in arrivo
    const man = parseFloat(p?.costoNetto) || (parseFloat(p?.costo)? parseFloat(p.costo)/(1+ivaAcq/100) : 0);
    const auto = a&&a.pezzi? a.costo/a.pezzi : (a?.stima||0);
    return {
      id: p?.id || "auto:"+key, saved: !!p, key, cat, tipo, formato, unita, ref,
      nome: p?.nome || ref.nomeVino || "", produttore: p?.produttore ?? ref.produttore ?? "",
      fornitore: p?.fornitore || a?.forn || (a? [...a.fornitori].join(", ") : ""),
      dosiTeo, resa, dosi: Math.max(0.01, dosiTeo*resa/100),
      prezzoProprio: parseFloat(p?.prezzo)||0,
      prezzo: parseFloat(p?.prezzo) || ((cat==="birre" && unita==="bicchiere" && _barSpina())? _barSpina().media.prezzo : _barPrezzoDef(cat)),
      prezzoPiccolaProprio: parseFloat(p?.prezzoPiccola)||0, prezzoPiccola: parseFloat(p?.prezzoPiccola) || (_barSpina()?.piccola.prezzo||0),
      dosecl: parseFloat(p?.dosecl) || d.dosecl || 0, uso: p?.uso || "vendita",
      eta: p?.eta ?? ref.eta ?? "", gradazione: p?.gradazione ?? ref.gradazione ?? "",
      ivaAcq, costoAuto: auto, costoProprio: man,
      costoFonte: man? "manuale" : a&&a.pezzi? "ordini" : a?.stima? "stima" : "",
      costoNet: man || auto,
      scortaMin: parseFloat(p?.scortaMin)||0,
      inArrivo: !!a?.pend, inOrdine: !!a?.inOrdine,
      attivo: p ? p.attivo!==false : true
    };
  };
  saved.forEach(p=>{ if(!p.eliminato) res.push(mk(p.key, p, agg.get(p.key))); });   // eliminati: nascosti e non riscoperti dagli ordini
  agg.forEach((a,k)=>{ if(!byKey.has(k)) res.push(mk(k, null, a)); });
  return res.sort((x,y)=>(x.cat+x.tipo+x.nome).localeCompare(y.cat+y.tipo+y.nome,"it"));
}
// Materializza un prodotto scoperto (serve un id stabile per uscite/conte)
function _barEnsure(p){
  if(p.saved) return p.id;
  const gia = bar.find(x=>x.t==="p" && x.key===p.key); if(gia) return gia.id;   // idempotente (stesso prodotto in più righe)
  const rec = { id:uid(), t:"p", key:p.key, cat:p.cat, nome:p.nome, produttore:p.produttore, formato:p.formato,
    tipo:p.tipo, unita:p.unita, dosi:p.dosiTeo, dosecl:p.dosecl||0, uso:p.uso||"vendita", eta:p.eta||"", gradazione:p.gradazione||"", prezzo:p.prezzoProprio||0, attivo:true };
  bar.push(rec); return rec.id;
}

// ─── Uscite: conversione in pezzi e ricavo ───────────────────────────────────
// Pezzi consumati da un'uscita: ingredienti cocktail in cl, piccole spina in proporzione, il resto in unità di vendita.
function _barMovPz(m,p){
  if(!p) return 0;
  if(m.cl!=null){ const f=parseFloat(p.formato)||0; return f? (parseFloat(m.cl)||0)/(f*100)/(p.resa/100) : 0; }
  const u = (parseFloat(m.qty)||0) * (m.taglia==="piccola" && p.dosecl ? (_barSpina()?.piccola.cl||0)/p.dosecl : 1);
  return u/(p.dosi||1);
}
// Ricavo lordo IVA di un'uscita di vendita (ingredienti cocktail: quota assegnata in m.ric)
const _barMovRic = (m,p) => m.ric!=null ? (parseFloat(m.ric)||0) : p ? (parseFloat(m.qty)||0) * (m.taglia==="piccola" ? p.prezzoPiccola : p.prezzo) : 0;

// ─── Cocktail: costo ricetta e ripartizione del prezzo sugli ingredienti ─────
function _barRicetta(k, pById){
  let costo = parseFloat(k.extra)||0; const righe = [];
  (k.ingr||[]).forEach(g=>{
    const p = pById.get(g.pid), cl = parseFloat(g.cl)||0;
    const c = p && parseFloat(p.formato)? p.costoNet/(parseFloat(p.formato)*100*(p.resa/100))*cl : 0;
    costo += c; righe.push({ g, p, cl, c });
  });
  return { costo, righe, netto:_barNet(k.prezzo) };
}
// Ricavo netto stimato per cl di un ingrediente "nei cocktail": media sulle ricette che lo usano (quota ∝ costo)
function _barRicPerCl(pid, pById){
  const ks = bar.filter(x=>x.t==="k" && (x.ingr||[]).some(g=>g.pid===pid)); if(!ks.length) return 0;
  let tot=0, n=0;
  ks.forEach(k=>{ const R=_barRicetta(k,pById); R.righe.filter(r=>r.g.pid===pid&&r.cl).forEach(r=>{ if(R.costo>0){ tot+=R.netto*(r.c/R.costo)/r.cl; n++; } }); });
  return n? tot/n : 0;
}

// ─── Calcoli ─────────────────────────────────────────────────────────────────
function _barPrevDay(d){ const x=new Date(d+"T00:00:00"); x.setDate(x.getDate()-1); return _isoDate(x); }
function _barRange(){
  const t = today(), y = t.slice(0,4), ym = t.slice(0,7);
  if(barUi.per==="settimana"){ const d=new Date(t+"T00:00:00"); d.setDate(d.getDate()-6); return [_isoDate(d), t]; }
  if(barUi.per==="mese") return [ym+"-01", t];
  if(barUi.per==="mesescorso"){ const d=new Date(ym+"-01T00:00:00"); d.setDate(0); const e=_isoDate(d); return [e.slice(0,7)+"-01", e]; }
  if(barUi.per==="anno") return [y+"-01-01", t];
  return [barUi.da||ym+"-01", barUi.a||t];
}
// Giacenza (pezzi) a fine giornata D: ultima conta + carichi − uscite successive.
function _barGiac(ix, D){
  let base = 0, from = "";
  for(const c of ix.conte) if(c.data<=D && c.data>=from){ base = parseFloat(c.pezzi)||0; from = c.data; }
  const after = d => from ? d>from : true;
  let g = base;
  ix.car.forEach(c=>{ if(c.data<=D && after(c.data)) g+=c.pezzi; });
  ix.mov.forEach(m=>{ if(m.data<=D && after(m.data)) g-=_barMovPz(m,ix.p); });
  return { g, conta: from };
}
function _barIndex(prods){
  const car = _barCarichi(), byId = new Map(prods.map(p=>[p.id,p])), byKey = new Map(prods.map(p=>[p.key,p]));
  const ix = new Map(prods.map(p=>[p.id,{ p, car:[], mov:[], conte:[] }]));
  car.forEach(c=>{ const p=byKey.get(c.key); if(p) ix.get(p.id).car.push(c); });
  bar.forEach(x=>{ if((x.t==="m"||x.t==="c") && byId.has(x.pid)) ix.get(x.pid)[x.t==="m"?"mov":"conte"].push(x); });
  return ix;
}
function _barStats(da, a){
  const prods = _barProdotti(), ix = _barIndex(prods), pre = _barPrevDay(da), rows = [];
  const pById = new Map(prods.map(p=>[p.id,p]));
  ix.forEach(i=>{
    const p = i.p; if(barUi.cat!=="tutte" && p.cat!==barUi.cat) return;
    if(p.inArrivo && !i.mov.length && !i.conte.length) return;
    const gi = _barGiac(i, pre), gf = _barGiac(i, a);
    const carP = i.car.filter(c=>c.data>=da&&c.data<=a), car = carP.reduce((s,c)=>s+c.pezzi,0);
    const acqNet = carP.reduce((s,c)=>s+c.costoNet,0), acqLordo = carP.reduce((s,c)=>s+c.costoLordo,0);
    const mv = i.mov.filter(m=>m.data>=da&&m.data<=a), mvV = mv.filter(m=>m.tipo==="vend");
    const auto = mv.filter(m=>m.tipo==="auto").reduce((s,m)=>s+_barMovPz(m,p),0);
    const vend = mvV.reduce((s,m)=>s+_barMovPz(m,p),0);
    const consumo = gi.g + car - gf.g;
    const nonReg = consumo - auto - vend;
    if(!car && !auto && !vend && Math.abs(consumo)<1e-9 && Math.abs(gf.g)<1e-9) return;
    // Ricavo netto: vendite da cassa se ci sono (allora il "non registrato" è scarto/ammanco), altrimenti stima dal consumo
    let ricavo, stimato = false;
    if(mvV.length) ricavo = _barNet(mvV.reduce((s,m)=>s+_barMovRic(m,p),0));
    else { stimato = true; const est = Math.max(0, consumo - auto);
      ricavo = _barCock(p) ? est*(parseFloat(p.formato)||0)*100*(p.resa/100)*_barRicPerCl(p.id,pById) : est*p.dosi*_barNet(p.prezzo); }
    rows.push({ p, gi:gi.g, gf:gf.g, contaFin:gf.conta, car, acqNet, acqLordo, auto, vend, consumo, nonReg, stimato, cassa:mvV.length>0,
      cConsumo: consumo*p.costoNet, cAuto: auto*p.costoNet, ricavo, valFin: Math.max(0,gf.g)*p.costoNet });
  });
  return rows;
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function _barCatLbl(k){ return ORD_CAT[k]?.label || k; }
function _barCatDot(k){ return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${ORD_CAT[k]?.color||"var(--txt4)"};margin-right:6px"></span>`; }
const _barPz = n => fmtN(n, Math.abs(n%1)<1e-9?0:1);
const _barTh = (l,al) => `<th style="padding:8px;text-align:${al||"right"};font-size:11px;color:var(--txt4);font-weight:500;text-transform:uppercase;letter-spacing:.04em">${l}</th>`;
const _barNota = (txt,col) => `<div class="card" style="margin-bottom:16px;border-left:3px solid ${col||"var(--orange)"};font-size:12px;color:var(--txt2)">${ic("alert")} ${txt}</div>`;
function barSet(k,v){ barUi[k]=v; render(); }

function renderBar(){
  const tabs = [["riepilogo","Riepilogo"],["conta","Giacenze & conta"],["cassa","Vendite cassa"],["cocktail","Cocktail"],["registra","Autoconsumo"],["prodotti","Prodotti"]];
  let html = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${tabs.map(([k,l])=>
    `<button class="${barUi.tab===k?"btn-primary":"btn-outline"} btn-sm" onclick="barSet('tab','${k}')">${l}</button>`).join("")}</div>`;
  if(!_barTableOk) html += _barNota(`Tabella <code>cm_bar</code> non raggiungibile: i dati restano solo su questo computer.`);
  const catSel = `<div><label class="form-label">Categoria</label><select class="form-select" onchange="barSet('cat',this.value)">
    <option value="tutte">Tutte</option>${Object.entries(ORD_CAT).map(([k,c])=>`<option value="${k}" ${barUi.cat===k?"selected":""}>${h(c.label)}</option>`).join("")}</select></div>`;
  if(barUi.tab==="riepilogo") html += _barRiepilogo(catSel);
  else if(barUi.tab==="registra"){ html += _barRegistra(); setTimeout(_barUnHint,0); }
  else if(barUi.tab==="conta") html += _barConta(catSel);
  else if(barUi.tab==="cassa") html += _barCassa(catSel);
  else if(barUi.tab==="cocktail") html += _barCocktailUi();
  else html += _barProdottiUi(catSel);
  return html;
}

function _barRiepilogo(catSel){
  const [da,a] = _barRange(), rows = _barStats(da,a);
  const S = k => rows.reduce((s,r)=>s+r[k],0);
  const acqL=S("acqLordo"), acqN=S("acqNet"), cCons=S("cConsumo"), cAuto=S("cAuto"), ric=S("ricavo"), valFin=S("valFin");
  const cVend = cCons - cAuto, inc = ric? cVend/ric*100 : 0;
  const senzaConta = rows.filter(r=>!r.contaFin || r.contaFin<a).length;
  const ammanchi = rows.filter(r=>r.cassa && r.nonReg>0.01), stimati = rows.some(r=>r.stimato);
  const kpi=(l,v,col,sub)=>`<div class="card" style="padding:14px"><div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">${l}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:1.4rem;color:${col}">${v}</div><div style="font-size:12px;color:var(--txt4);margin-top:4px">${sub}</div></div>`;
  let html = `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">
    <div><label class="form-label">Periodo</label><select class="form-select" onchange="barSet('per',this.value)">
      ${[["settimana","Ultimi 7 giorni"],["mese","Mese corrente"],["mesescorso","Mese scorso"],["anno","Anno"],["custom","Personalizzato"]].map(([k,l])=>`<option value="${k}" ${barUi.per===k?"selected":""}>${l}</option>`).join("")}</select></div>
    ${barUi.per==="custom"?`<div><label class="form-label">Dal</label><input type="date" class="form-input" value="${da}" onchange="barSet('da',this.value)"></div>
    <div><label class="form-label">Al</label><input type="date" class="form-input" value="${a}" onchange="barSet('a',this.value)"></div>`:""}
    ${catSel}</div><div style="font-size:12px;color:var(--txt4);margin-top:10px">Importi IVA esclusa (costi e ricavi), tranne la spesa acquisti che mostra anche il totale con IVA.</div></div>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px">
    ${kpi("Spesa acquisti", fmt(acqL), "var(--txt)", `IVA incl. · ${fmt(acqN)} netto`)}
    ${kpi("Consumo a costo", fmt(cCons), "var(--txt)", "giac. iniziale + carichi − giac. finale")}
    ${kpi("Autoconsumo", fmt(cAuto), cAuto>0?"var(--orange)":"var(--txt3)", cCons? `${fmtN(cAuto/cCons*100,1)}% del consumo`:"—")}
    ${kpi(stimati?"Ricavo stimato":"Ricavo da cassa", fmt(ric), "var(--green)", stimati? "dal consumo × prezzo (o vendite cassa dove inserite)":"vendite cassa inserite")}
    ${kpi("Incidenza costo", ric? fmtN(inc,1)+"%":"—", inc>30?"var(--red)":"var(--txt)", "costo venduto / ricavo")}
    ${kpi("Valore magazzino", fmt(valFin), "var(--txt)", "a costo netto, fine periodo")}
  </div>`;
  if(senzaConta && rows.length) html += _barNota(`${senzaConta} prodott${senzaConta===1?"o":"i"} senza conta al ${_barFmtD(a)}: giacenza finale teorica, quindi consumo e ricavo stimati sono provvisori. Fai la conta settimanale per avere il dato vero.`);
  if(ammanchi.length) html += _barNota(`Uscite oltre le vendite di cassa (scarto/ammanco, già al netto della resa): ${ammanchi.map(r=>`${h(r.p.nome)} ${_barPz(r.nonReg)} pz`).join(" · ")}.`, "var(--red)");
  const cats = Object.keys(ORD_CAT).filter(k=>rows.some(r=>r.p.cat===k));
  if(cats.length) html += `<div class="card" style="margin-bottom:16px"><div class="card-header"><span>${ic("chart")} Per categoria</span><span style="font-size:11px;color:var(--txt4)">IVA escl. · spesa IVA incl.</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:var(--txt4);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
    <td style="padding:8px 14px">Categoria</td><td style="text-align:right;padding:8px">Spesa</td><td style="text-align:right;padding:8px">Consumo</td><td style="text-align:right;padding:8px">Autoconsumo</td><td style="text-align:right;padding:8px">Ricavo</td><td style="text-align:right;padding:8px 14px">Incidenza</td></tr></thead><tbody>
    ${cats.map(k=>{ const rr=rows.filter(r=>r.p.cat===k), s=f=>rr.reduce((x,r)=>x+r[f],0), cc=s("cConsumo"), ca=s("cAuto"), rc=s("ricavo");
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 14px">${_barCatDot(k)}${h(_barCatLbl(k))}</td><td style="text-align:right;padding:6px 8px">${fmt(s("acqLordo"))}</td>
      <td style="text-align:right;padding:6px 8px">${fmt(cc)}</td><td style="text-align:right;padding:6px 8px">${fmt(ca)}</td><td style="text-align:right;padding:6px 8px">${fmt(rc)}</td>
      <td style="text-align:right;padding:6px 14px;color:var(--txt3)">${rc?fmtN((cc-ca)/rc*100,0)+"%":"—"}</td></tr>`; }).join("")}</tbody></table></div>`;
  const th=_barTh;
  html += `<div class="card" style="overflow-x:auto"><div class="card-header"><span>${ic("bottle")} Per prodotto</span><span style="font-size:11px;color:var(--txt4)">quantità in pezzi (bottiglie / fusti / lattine)</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:900px"><thead><tr>${th("Prodotto","left")}${th("Giac. iniz.")}${th("Carichi")}${th("Giac. fin.")}${th("Consumo")}${th("Autocons.")}${th("Venduto cassa")}${th("Scarto")}${th("Costo consumo")}${th("Ricavo")}</tr></thead><tbody>
    ${rows.length? rows.sort((x,y)=>y.cConsumo-x.cConsumo).map(r=>`<tr style="border-top:1px solid var(--border)">
      <td style="padding:6px 8px">${_barCatDot(r.p.cat)}${h(r.p.nome)}${r.p.produttore?` <span style="color:var(--txt4)">· ${h(r.p.produttore)}</span>`:""}${r.contaFin?"":` <span style="color:var(--orange);font-size:10px">teorica</span>`}${!r.p.prezzo&&!_barCock(r.p)?` <span style="color:var(--red);font-size:10px">senza prezzo</span>`:""}${_barCock(r.p)?` <span style="color:var(--txt4);font-size:10px">nei cocktail</span>`:""}</td>
      <td style="text-align:right;padding:6px 8px">${_barPz(r.gi)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.car)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.gf)}</td>
      <td style="text-align:right;padding:6px 8px">${_barPz(r.consumo)}</td><td style="text-align:right;padding:6px 8px">${_barPz(r.auto)}</td><td style="text-align:right;padding:6px 8px">${r.cassa?_barPz(r.vend):"—"}</td>
      <td style="text-align:right;padding:6px 8px;color:${r.cassa&&r.nonReg>0.01?"var(--red)":"var(--txt3)"}">${r.cassa?_barPz(r.nonReg):"—"}</td>
      <td style="text-align:right;padding:6px 8px">${fmt(r.cConsumo)}</td><td style="text-align:right;padding:6px 8px">${fmt(r.ricavo)}${r.stimato?` <span style="color:var(--txt4);font-size:10px">stima</span>`:""}</td></tr>`).join("")
      : `<tr><td colspan="10" style="padding:20px;text-align:center;color:var(--txt4)">Nessun movimento nel periodo. I prodotti compaiono quando un ordine bar viene caricato.</td></tr>`}
    </tbody></table></div>`;
  return html;
}

// ─── Autoconsumo (e vendite singole, facoltative) ────────────────────────────
function _barRegistra(){
  const all = _barProdotti(), prods = all.filter(p=>p.attivo && !p.inArrivo);
  const opts = prods.map(p=>`<option value="${h(p.id)}">${h(_barCatLbl(p.cat))} — ${h(p.nome)}${p.produttore?" · "+h(p.produttore):""}</option>`).join("");
  const movs = bar.filter(x=>x.t==="m" && !x.lotto).sort((x,y)=>(y.data+(y.ts||"")).localeCompare(x.data+(x.ts||""))).slice(0,60);
  const pById = new Map(all.map(p=>[p.id,p]));
  return `<div class="card" style="margin-bottom:16px"><div class="card-header"><span>${ic("plus")} Registra autoconsumo</span><span style="font-size:11px;color:var(--txt4)">staff, omaggi, cucina, rotture: tutto ciò che esce senza essere venduto</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">
      <div><label class="form-label">Data</label><input type="date" id="bar-m-data" class="form-input" value="${today()}"></div>
      <div style="grid-column:span 2"><label class="form-label">Prodotto</label><select id="bar-m-pid" class="form-select" onchange="_barUnHint()">${opts||`<option value="">Nessun prodotto</option>`}</select></div>
      <div><label class="form-label">Tipo</label><select id="bar-m-tipo" class="form-select" onchange="document.getElementById('bar-m-caus-w').style.display=this.value==='auto'?'':'none'">
        <option value="auto">Autoconsumo</option><option value="vend">Vendita singola</option></select></div>
      <div id="bar-m-caus-w"><label class="form-label">Causale</label><select id="bar-m-caus" class="form-select">${BAR_CAUSALI.map(c=>`<option>${h(c)}</option>`).join("")}</select></div>
      <div id="bar-m-taglia-w" style="display:none"><label class="form-label">Misura</label><select id="bar-m-taglia" class="form-select"><option value="media">Media</option><option value="piccola">Piccola</option></select></div>
      <div><label class="form-label">Quantità <span id="bar-m-un" style="color:var(--txt4)"></span></label><input type="number" id="bar-m-qty" class="form-input" min="0" step="0.5" value="1"></div>
      <div><label class="form-label">Note</label><input id="bar-m-note" class="form-input"></div>
      <div><button class="btn-primary" onclick="barAddMov()">Registra</button></div>
    </div><div style="font-size:12px;color:var(--txt4);margin-top:10px">Le vendite non serve segnarle una per una: si stimano dalle conte o si inseriscono a settimana in "Vendite cassa".</div></div>
    <div class="card" style="overflow-x:auto"><div class="card-header"><span>${ic("clipboard")} Ultime registrazioni</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
    ${movs.length? movs.map(m=>{ const p=pById.get(m.pid); const v=p?_barMovPz(m,p)*p.costoNet:0;
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px;white-space:nowrap">${_barFmtD(m.data)}</td>
      <td style="padding:6px 8px">${m.tipo==="auto"?`<span style="color:var(--orange)">Autoconsumo</span> · ${h(m.causale||"")}`:`<span style="color:var(--green)">Vendita</span>`}</td>
      <td style="padding:6px 8px">${p?h(p.nome):"<i>prodotto rimosso</i>"}</td><td style="padding:6px 8px;text-align:right">${fmtN(parseFloat(m.qty)||0,1)} ${m.taglia? (m.taglia==="piccola"?"piccole":"medie") : p?h((BAR_UNITA[p.unita]||"").toLowerCase()):""}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--txt3)">${fmt(v)}</td><td style="padding:6px 8px;color:var(--txt4)">${h(m.note||"")}</td>
      <td style="padding:6px 8px;text-align:right"><button class="btn-outline btn-sm" onclick="barDel('${m.id}')">${ic("trash")}</button></td></tr>`; }).join("")
      : `<tr><td style="padding:20px;text-align:center;color:var(--txt4)">Nessuna registrazione.</td></tr>`}
    </tbody></table></div>`;
}
function _barUnHint(){
  const el=document.getElementById("bar-m-un"), id=document.getElementById("bar-m-pid")?.value;
  const p=_barProdotti().find(x=>x.id===id); if(el) el.textContent=p?`(${(_barTaglie(p)?"bicchieri":(BAR_UNITA[p.unita]||p.unita)).toLowerCase()})`:"";
  const tw=document.getElementById("bar-m-taglia-w"); if(tw) tw.style.display=_barTaglie(p)?"":"none";
}
async function barAddMov(){
  const sel = document.getElementById("bar-m-pid").value, qty = parseFloat(document.getElementById("bar-m-qty").value)||0;
  if(!sel){ notify("Scegli un prodotto","err"); return; }
  if(qty<=0){ notify("Quantità non valida","err"); return; }
  const p = _barProdotti().find(x=>x.id===sel); if(!p) return;
  const pid = _barEnsure(p), tipo = document.getElementById("bar-m-tipo").value;
  bar.push({ id:uid(), t:"m", ts:Date.now(), data:document.getElementById("bar-m-data").value||today(), pid, tipo,
    causale: tipo==="auto"? document.getElementById("bar-m-caus").value : "", qty,
    ...(_barTaglie(p)? { taglia: document.getElementById("bar-m-taglia").value } : {}), note:(document.getElementById("bar-m-note").value||"").trim() });
  render(); notify(tipo==="auto"?"Autoconsumo registrato":"Vendita registrata");
  await _barSave(); if(section==="bar") render();
}
async function barDel(id){
  if(!confirm("Eliminare la registrazione?")) return;
  bar = bar.filter(x=>x.id!==id); render(); await _barSave(); if(section==="bar") render();
}

// ─── Giacenze, conta settimanale e riordino ──────────────────────────────────
function _barConta(catSel){
  const D = barUi.contaData || today();
  const all = _barProdotti(), prods = all.filter(p=>p.attivo && !p.inArrivo && (barUi.cat==="tutte"||p.cat===barUi.cat)), ix = _barIndex(prods);
  const arrivo = all.filter(p=>p.inArrivo && (barUi.cat==="tutte"||p.cat===barUi.cat));
  const esist = new Map(bar.filter(x=>x.t==="c"&&x.data===D).map(c=>[c.pid,c]));
  const storico = [...bar.filter(x=>x.t==="c").reduce((m,c)=>m.set(c.data,(m.get(c.data)||0)+1),new Map())].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,24);
  // Da riordinare: giacenza teorica di oggi ≤ scorta minima, non già in un ordine in attesa
  const gruppi = new Map();
  prods.forEach(p=>{ if(!p.scortaMin || p.inOrdine) return; const g=_barGiac(ix.get(p.id),today()).g; if(g>p.scortaMin) return;
    const k=(p.fornitore||"—")+"|"+p.cat; if(!gruppi.has(k)) gruppi.set(k,{forn:p.fornitore,cat:p.cat,items:[]}); gruppi.get(k).items.push({p,g}); });
  const step = p => p.cat==="sodati"||(p.cat==="birre"&&p.unita!=="bicchiere")?1:0.25;
  return `${gruppi.size?`<div class="card" style="margin-bottom:16px;border-left:3px solid var(--orange)"><div class="card-header"><span>${ic("alert")} Da riordinare</span><span style="font-size:11px;color:var(--txt4)">giacenza ≤ scorta minima</span></div>
      ${[...gruppi.values()].map(gr=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border)">
        <div style="font-size:13px">${_barCatDot(gr.cat)}<b>${h(gr.forn||"Fornitore sconosciuto")}</b> · ${gr.items.map(x=>`${h(x.p.nome)} <span style="color:var(--txt4)">(${_barPz(Math.max(0,x.g))}/${_barPz(x.p.scortaMin)})</span>`).join(", ")}</div>
        ${gr.forn?`<button class="btn-primary btn-sm" onclick='barRiordina(${JSON.stringify(gr.items.map(x=>x.p.id))})'>Crea ordine</button>`:""}</div>`).join("")}</div>`:""}
    <div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">
      <div><label class="form-label">Data conta (fine giornata)</label><input type="date" class="form-input" value="${D}" onchange="barSet('contaData',this.value)"></div>${catSel}
      <div><button class="btn-primary" onclick="barSalvaConta()">Salva conta</button></div></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">Una volta a settimana: conta i pezzi fisici (${BAR_SCHEDA[barUi.cat]? BAR_SCHEDA[barUi.cat].contaHint : "spirits e fusti a frazione, bottiglie e lattine intere"}) e salva. Lascia vuoto ciò che non hai contato. La colonna "Disponibile" è la giacenza teorica di oggi.</div></div>
    <div class="card" style="overflow-x:auto;margin-bottom:16px"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>${_barTh("Prodotto","left")}${_barTh("Disponibile")}${_barTh("Scorta min.")}${_barTh("Conta")}</tr></thead><tbody>
    ${prods.length? prods.map(p=>{ const i=ix.get(p.id), teo=_barGiac(i,D).g, c=esist.get(p.saved?p.id:""), basso=p.scortaMin&&teo<=p.scortaMin;
      return `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px">${_barCatDot(p.cat)}${h(p.nome)}${p.produttore?` <span style="color:var(--txt4)">· ${h(p.produttore)}</span>`:""}${_barDett(p)?` <span style="color:var(--txt4)">· ${h(_barDett(p))}</span>`:""}${p.inOrdine?` <span style="color:var(--txt4);font-size:10px">riordinato</span>`:""}</td>
      <td style="padding:6px 8px;text-align:right;white-space:nowrap;color:${basso?"var(--orange)":"var(--txt2)"}">${_barPz(teo)}</td>
      <td style="padding:6px 8px;text-align:right;color:var(--txt4)">${p.scortaMin?_barPz(p.scortaMin):"—"}</td>
      <td style="padding:6px 8px;width:110px"><input type="number" class="form-input bar-conta" data-pid="${h(p.id)}" min="0" step="${step(p)}" value="${c?c.pezzi:""}" placeholder="${_barPz(Math.max(0,teo))}"></td></tr>`; }).join("")
      : `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--txt4)">Nessun prodotto.</td></tr>`}
    </tbody></table></div>
    ${arrivo.length?`<div class="card" style="margin-bottom:16px;font-size:12px;color:var(--txt3)">${ic("clock")} In arrivo (non si contano finché non registri l'arrivo da Ordini → Ricevi): ${arrivo.map(p=>h(p.nome)).join(", ")}</div>`:""}
    ${storico.length?`<div class="card"><div class="card-header"><span>${ic("calendar")} Conte salvate</span></div><div style="display:flex;flex-wrap:wrap;gap:8px">
      ${storico.map(([d,n])=>`<span class="btn-outline btn-sm" style="display:inline-flex;gap:8px;align-items:center"><a href="#" onclick="barSet('contaData','${d}');return false" style="color:inherit">${_barFmtD(d)} · ${n}</a>
      <a href="#" title="Elimina conta" onclick="barDelConta('${d}');return false" style="color:var(--red)">${ic("x")}</a></span>`).join("")}</div></div>`:""}`;
}
async function barSalvaConta(){
  const D = barUi.contaData || today(), prods = _barProdotti(); let n = 0;
  document.querySelectorAll(".bar-conta").forEach(inp=>{
    if(inp.value==="") return;
    const v = parseFloat(inp.value); if(isNaN(v)||v<0) return;
    const p = prods.find(x=>x.id===inp.dataset.pid); if(!p || p.inArrivo) return;
    const pid = _barEnsure(p);
    const ex = bar.find(x=>x.t==="c"&&x.pid===pid&&x.data===D);
    if(ex) ex.pezzi = v; else bar.push({ id:uid(), t:"c", data:D, pid, pezzi:v });
    n++;
  });
  if(!n){ notify("Nessuna quantità inserita","err"); return; }
  notify(`Conta salvata: ${n} prodott${n===1?"o":"i"}`); render(); await _barSave(); if(section==="bar") render();
}
async function barDelConta(d){
  if(!confirm(`Eliminare la conta del ${_barFmtD(d)}?`)) return;
  bar = bar.filter(x=>!(x.t==="c"&&x.data===d)); render(); await _barSave(); if(section==="bar") render();
}
// Apre "Nuovo ordine" già compilato (fornitore, categoria, ultime condizioni d'acquisto): si controlla e si salva.
function barRiordina(ids){
  const prods = _barProdotti().filter(p=>ids.includes(p.id)); if(!prods.length) return;
  const cat = prods[0].cat, forn = (prods[0].fornitore||"").split(",")[0].trim();
  section = "ordini"; render(); apriOrdineModal(null);
  const fi = document.getElementById("omd-fornitore"); if(fi) fi.value = forn;
  ordineModalData.referenze = prods.map(p=>{ const r=_newRef(), ref=p.ref||{};
    return Object.assign(r, { produttore:p.produttore, nomeVino:p.nome, tipologia:p.tipo, formato:parseFloat(p.formato)||"", nazione:ref.nazione||"",
      eta:p.eta||"", gradazione:p.gradazione||"", prezzoAcq:parseFloat(ref.prezzoAcq)||"", iva:parseInt(ref.iva)||22, qty:parseInt(ref.qty)||6 }); });
  _setOrdineCategoria(cat);
  notify("Ordine precompilato: controlla quantità e prezzi, poi salva","info");
}

// ─── Vendite cassa (Tebi): inserimento settimanale dei totali ────────────────
function _barCassa(catSel){
  const D = barUi.cassaData || today();
  const prods = _barProdotti().filter(p=>p.attivo && !p.inArrivo && !_barCock(p) && (barUi.cat==="tutte"||p.cat===barUi.cat));
  const ks = bar.filter(x=>x.t==="k");
  const lotti = [...bar.filter(x=>x.t==="m"&&x.lotto).reduce((m,x)=>{ const l=m.get(x.lotto)||{data:x.data,n:0,ric:0}; l.n++; l.ric+=parseFloat(x.ric ?? 0)||0; return m.set(x.lotto,l); },new Map())].sort((a,b)=>b[1].data.localeCompare(a[1].data)).slice(0,20);
  const inp = (pid,tg,ph) => `<input type="number" class="form-input bar-cassa" data-pid="${h(pid)}" data-tg="${tg||""}" min="0" step="1" style="width:90px" placeholder="${ph||0}">`;
  return `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">
      <div><label class="form-label">Data (fine periodo)</label><input type="date" class="form-input" value="${D}" onchange="barSet('cassaData',this.value)"></div>${catSel}
      <div><button class="btn-primary" onclick="barSalvaCassa()">Salva vendite</button></div></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">Facoltativo. Copia dal report della cassa i pezzi venduti nel periodo (medie e piccole, bottiglie, cocktail). Con questi dati il ricavo diventa reale e la differenza con le conte mostra scarti e ammanchi. Senza, il ricavo resta stimato dalle conte.</div></div>
    <div class="card" style="overflow-x:auto;margin-bottom:16px"><table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>
    ${prods.map(p=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px">${_barCatDot(p.cat)}${h(p.nome)}${p.produttore?` <span style="color:var(--txt4)">· ${h(p.produttore)}</span>`:""}</td>
      ${_barTaglie(p)? `<td style="padding:6px 8px;text-align:right;white-space:nowrap">medie ${inp(p.id,"media")}</td><td style="padding:6px 8px;text-align:right;white-space:nowrap">piccole ${inp(p.id,"piccola")}</td>`
        : `<td style="padding:6px 8px;text-align:right;white-space:nowrap">${h((BAR_UNITA[p.unita]||"pezzi").toLowerCase())} ${inp(p.id,"")}</td><td></td>`}</tr>`).join("")}
    ${ks.map(k=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber);margin-right:6px"></span>Cocktail · ${h(k.nome)}</td>
      <td style="padding:6px 8px;text-align:right;white-space:nowrap">cocktail <input type="number" class="form-input bar-cassa-k" data-kid="${h(k.id)}" min="0" step="1" style="width:90px" placeholder="0"></td><td></td></tr>`).join("")}
    ${!prods.length&&!ks.length?`<tr><td style="padding:20px;text-align:center;color:var(--txt4)">Nessun prodotto.</td></tr>`:""}
    </tbody></table></div>
    ${lotti.length?`<div class="card"><div class="card-header"><span>${ic("calendar")} Vendite inserite</span></div><div style="display:flex;flex-wrap:wrap;gap:8px">
      ${lotti.map(([id,l])=>`<span class="btn-outline btn-sm" style="display:inline-flex;gap:8px;align-items:center">${_barFmtD(l.data)} · ${l.n} righe
      <a href="#" title="Elimina" onclick="barDelLotto('${id}');return false" style="color:var(--red)">${ic("x")}</a></span>`).join("")}</div></div>`:""}`;
}
async function barSalvaCassa(){
  const D = barUi.cassaData || today(), prods = _barProdotti(), pById = new Map(prods.map(p=>[p.id,p])), lotto = uid(); let n = 0;
  document.querySelectorAll(".bar-cassa").forEach(inp=>{
    const q = parseFloat(inp.value)||0; if(q<=0) return;
    const p = pById.get(inp.dataset.pid); if(!p) return;
    const m = { id:uid(), t:"m", ts:Date.now(), data:D, pid:_barEnsure(p), tipo:"vend", qty:q, fonte:"cassa", lotto };
    if(inp.dataset.tg) m.taglia = inp.dataset.tg;
    m.ric = _barMovRic(m, p); bar.push(m); n++;
  });
  document.querySelectorAll(".bar-cassa-k").forEach(inp=>{
    const q = parseFloat(inp.value)||0; if(q<=0) return;
    const k = bar.find(x=>x.id===inp.dataset.kid); if(!k) return;
    const R = _barRicetta(k, pById), lordo = q*(parseFloat(k.prezzo)||0);
    R.righe.filter(r=>r.p&&r.cl).forEach(r=>{
      bar.push({ id:uid(), t:"m", ts:Date.now(), data:D, pid:_barEnsure(r.p), tipo:"vend", cl:r.cl*q, ric: R.costo? lordo*r.c/R.costo : 0, fonte:"cocktail", kid:k.id, lotto, note:`${q} × ${k.nome}` });
    });
    n++;
  });
  if(!n){ notify("Nessuna vendita inserita","err"); return; }
  notify(`Vendite salvate (${n} righe)`); render(); await _barSave(); if(section==="bar") render();
}
async function barDelLotto(id){
  if(!confirm("Eliminare queste vendite di cassa?")) return;
  bar = bar.filter(x=>x.lotto!==id); render(); await _barSave(); if(section==="bar") render();
}

// ─── Cocktail: ricette, costo, incidenza ─────────────────────────────────────
const BAR_COCKTAIL_BASE = [
  { nome:"Negroni", prezzo:10, ingr:[{lbl:"Gin",cl:3},{lbl:"Bitter (Campari)",cl:3},{lbl:"Vermouth rosso",cl:3}] },
  { nome:"Negroni sbagliato", prezzo:10, extra:0.6, ingr:[{lbl:"Bitter (Campari)",cl:3},{lbl:"Vermouth rosso",cl:3}], nota:"spumante a parte (extra)" },
  { nome:"Americano", prezzo:10, ingr:[{lbl:"Bitter (Campari)",cl:3},{lbl:"Vermouth rosso",cl:3},{lbl:"Soda",cl:10}] },
  { nome:"Gin tonic", prezzo:10, ingr:[{lbl:"Gin",cl:5},{lbl:"Tonica",cl:20}] }
];
function _barCocktailUi(){
  const prods = _barProdotti(), pById = new Map(prods.map(p=>[p.id,p])), ks = bar.filter(x=>x.t==="k");
  const ing = prods.filter(p=>p.cat==="spirits"||p.cat==="sodati");
  const opt = sel => `<option value="">— scegli prodotto —</option>`+ing.map(p=>`<option value="${h(p.id)}" ${sel===p.id?"selected":""}>${h(p.nome)}${p.produttore?" · "+h(p.produttore):""}</option>`).join("");
  return `<div class="card" style="margin-bottom:16px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn-primary btn-sm" onclick="barNuovoCocktail()">+ Nuovo cocktail</button>
      ${ks.length?"":`<button class="btn-outline btn-sm" onclick="barCocktailBase()">Aggiungi ricette base (Negroni, Sbagliato, Americano, Gin tonic)</button>`}</div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">Per ogni cocktail: prezzo in carta (IVA incl.) e ingredienti in cl. Il costo si calcola dagli acquisti degli spirits e dei sodati. "Extra" = costi non a magazzino bar (spumante, ghiaccio, guarnizione), IVA esclusa. Gli ingredienti usati qui vanno impostati "Nei cocktail" in Prodotti.</div></div>
    ${ks.map(k=>{ const R=_barRicetta(k,pById), inc=R.netto? R.costo/R.netto*100 : 0;
      return `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div><label class="form-label">Nome</label><input class="form-input" value="${h(k.nome)}" onchange="barSetCocktail('${k.id}','nome',this.value)"></div>
        <div><label class="form-label">Prezzo (IVA incl.)</label><input type="number" class="form-input" style="width:100px" step="0.5" value="${k.prezzo||""}" onchange="barSetCocktail('${k.id}','prezzo',this.value)"></div>
        <div><label class="form-label">Extra €</label><input type="number" class="form-input" style="width:90px" step="0.05" value="${k.extra||""}" onchange="barSetCocktail('${k.id}','extra',this.value)"></div>
        <div style="margin-left:auto;text-align:right;font-size:13px">costo <b>${fmt(R.costo)}</b> · netto ${fmt(R.netto)} · incidenza <b style="color:${inc>25?"var(--orange)":"var(--green)"}">${R.netto?fmtN(inc,0)+"%":"—"}</b></div>
        <button class="btn-outline btn-sm" onclick="barDelCocktail('${k.id}')">${ic("trash")}</button></div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px"><tbody>
        ${R.righe.map((r,i)=>`<tr style="border-top:1px solid var(--border)"><td style="padding:5px 8px;color:var(--txt3);width:140px">${h(r.g.lbl||"Ingrediente")}</td>
          <td style="padding:5px 8px"><select class="form-select" style="padding:4px 6px" onchange="barSetIngr('${k.id}',${i},'pid',this.value)">${opt(r.g.pid)}</select></td>
          <td style="padding:5px 8px;width:110px"><input type="number" class="form-input" style="width:80px;padding:4px 6px" step="0.5" value="${r.cl||""}" onchange="barSetIngr('${k.id}',${i},'cl',this.value)"> cl</td>
          <td style="padding:5px 8px;text-align:right;width:80px;color:${r.p?"var(--txt2)":"var(--orange)"}">${r.p? fmt(r.c) : "manca"}</td>
          <td style="padding:5px 8px;width:40px;text-align:right"><a href="#" onclick="barSetIngr('${k.id}',${i},'del');return false" style="color:var(--txt4)">${ic("x")}</a></td></tr>`).join("")}
        </tbody></table><button class="btn-outline btn-sm" style="margin-top:8px" onclick="barSetIngr('${k.id}',-1,'add')">+ Ingrediente</button>
        ${k.nota?`<span style="font-size:11px;color:var(--txt4);margin-left:10px">${h(k.nota)}</span>`:""}</div>`; }).join("")}`;
}
async function barNuovoCocktail(){
  const nome = (prompt("Nome del cocktail")||"").trim(); if(!nome) return;
  const prezzo = parseFloat(String(prompt("Prezzo in carta (IVA incl.)","10")||"").replace(",","."))||0;
  bar.push({ id:uid(), t:"k", nome, prezzo, extra:0, ingr:[{lbl:"",pid:"",cl:4}] }); render(); await _barSave();
}
async function barCocktailBase(){
  const prods = _barProdotti().filter(p=>p.cat==="spirits"||p.cat==="sodati");
  const guess = lbl => { const w=_barNorm(lbl).split(/[ ()]+/).filter(x=>x.length>2); const p=prods.find(p=>w.some(x=>_barNorm(p.nome+" "+p.tipo).includes(x))); return p? _barEnsure(p) : ""; };
  BAR_COCKTAIL_BASE.forEach(b=>bar.push({ id:uid(), t:"k", nome:b.nome, prezzo:b.prezzo, extra:b.extra||0, nota:b.nota||"", ingr:b.ingr.map(g=>({ lbl:g.lbl, cl:g.cl, pid:guess(g.lbl) })) }));
  notify("Ricette base aggiunte: controlla prodotti e prezzi"); render(); await _barSave();
}
async function barSetCocktail(id,f,v){
  const k = bar.find(x=>x.id===id); if(!k) return;
  k[f] = f==="nome" ? String(v).trim() : Math.max(0, parseFloat(String(v).replace(",","."))||0);
  render(); await _barSave();
}
async function barSetIngr(id,i,f,v){
  const k = bar.find(x=>x.id===id); if(!k) return; k.ingr = k.ingr||[];
  if(f==="add") k.ingr.push({lbl:"",pid:"",cl:4});
  else if(f==="del") k.ingr.splice(i,1);
  else if(f==="pid"){ const p=_barProdotti().find(x=>x.id===v); k.ingr[i].pid = p? _barEnsure(p) : ""; if(p && !k.ingr[i].lbl) k.ingr[i].lbl = p.nome; }
  else k.ingr[i][f] = Math.max(0, parseFloat(String(v).replace(",","."))||0);
  render(); await _barSave();
}
async function barDelCocktail(id){
  if(!confirm("Eliminare il cocktail? Le vendite già inserite restano.")) return;
  bar = bar.filter(x=>x.id!==id); render(); await _barSave();
}

// ─── Prodotti ────────────────────────────────────────────────────────────────
function _barProdottiUi(catSel){
  const prods = _barProdotti().filter(p=>(barUi.cat==="tutte"||p.cat===barUi.cat) && (!barUi.q || _barNorm(p.nome+" "+p.produttore+" "+p.fornitore).includes(_barNorm(barUi.q))));
  const ix = _barIndex(prods), t = today(), cat = barUi.cat, S = BAR_SCHEDA[cat];
  const th = (l,al) => _barTh(l,al||"left");
  const td = (x,st) => `<td style="padding:6px 8px;${st||""}">${x}</td>`;
  const inp = (p,f,v,step,w,ph) => `<input type="number" class="form-input" style="width:${w||80}px;padding:4px 6px" min="0" step="${step}" value="${v||""}"${ph?` placeholder="${ph}"`:""} onchange="barSetProd('${h(p.id)}','${f}',this.value)">`;
  const sel = (p,f,opts,cur,w) => `<select class="form-select" style="width:${w||120}px;padding:4px 6px" onchange="barSetProd('${h(p.id)}','${f}',this.value)">${opts.map(([k,l])=>`<option value="${k}" ${cur===k?"selected":""}>${l}</option>`).join("")}</select>`;
  const aDose = p => p.unita==="dose"||p.unita==="bicchiere";
  const dash = `<span style="color:var(--txt4)">—</span>`;
  const C = {
    prod:  ["Prodotto","left", p=>td(`${_barCatDot(p.cat)}${h(p.nome)}${p.inArrivo?` <span style="color:var(--orange);font-size:10px" title="Ordine non ancora ricevuto: giacenza 0 finché non registri l'arrivo">in arrivo</span>`:""}${p.produttore?` <span style="color:var(--txt4)">· ${h(p.produttore)}</span>`:""}<div style="font-size:11px;color:var(--txt4)">${h(_barDett(p))}</div>`)],
    forn:  ["Fornitore","left", p=>td(h(p.fornitore||"—"),"color:var(--txt3)")],
    unita: ["Unità vendita","left", p=>td(sel(p,"unita",Object.entries(BAR_UNITA),p.unita))],
    dosi:  ["Unità/pezzo","left", p=>td(inp(p,"dosi",p.dosiTeo,"0.5",70))],
    servizio:["Servizio","left", p=>td(sel(p,"unita",[["bicchiere","Spina"],["bottiglia","Bottiglia / lattina"]],p.unita==="bicchiere"?"bicchiere":"bottiglia",140))],
    dosecl:[cat==="birre"&&_barSpina()?"Media cl":"Dose cl","left", p=>td(aDose(p)? inp(p,"dosecl",p.dosecl||"","0.5",64) : dash)],
    resaP: [`<span title="Quota del pezzo che diventa davvero venduto: per i fusti toglie schiuma, spurgo e fondo (di solito 90%).">Resa % ⓘ</span>`,"left", p=>td(aDose(p)? inp(p,"resa",p.resa,"1",60) : dash)],
    nDosi: [cat==="kegvino"?"Calici/fusto":cat==="birre"&&_barSpina()?"Medie/fusto":(cat==="birre"||cat==="kegcocktail")?"Bicchieri/fusto":"Dosi/bottiglia","right", p=>td(aDose(p)? _barPz(p.dosi)+(p.resa<100?`<div style="font-size:10px;color:var(--txt4)">teoriche ${_barPz(p.dosiTeo)}</div>`:"") : "1","text-align:right")],
    uso:   ["Uso","left", p=>td(sel(p,"uso",[["vendita","Vendita"],["cocktail","Nei cocktail"]],_barCock(p)?"cocktail":"vendita",120))],
    prezzo:[cat==="birre"&&_barSpina()?"Prezzo media / pezzo":S?S.prezzoLbl:"Prezzo unità","left", p=>td(_barCock(p)? dash : inp(p,"prezzo",p.prezzoProprio,"0.5",80,p.prezzo||""))],
    prezzoP:["Prezzo piccola","left", p=>td(_barTaglie(p)? inp(p,"prezzoPiccola",p.prezzoPiccolaProprio,"0.5",80,p.prezzoPiccola||"") : dash)],
    costo: [`<span title="Quanto paghi un pezzo intero (bottiglia, lattina o fusto), IVA esclusa come in fattura. Si calcola da solo dagli ordini: scrivilo solo per correggerlo.">Costo pz IVA escl. ⓘ</span>`,"left", p=>td(`${inp(p,"costoNetto",p.costoProprio? +p.costoProprio.toFixed(2):"","0.01",80,p.costoAuto? p.costoAuto.toFixed(2):"")}<div style="font-size:10px;color:${p.costoFonte==="manuale"?"var(--orange)":"var(--txt4)"}">${p.costoFonte==="ordini"?"media ordini":p.costoFonte==="stima"?"da ordine in arrivo":p.costoFonte==="manuale"?"manuale · auto "+fmt(p.costoAuto):"manca: scrivilo"}</div>`)],
    cu:    [cat==="spirits"?"Costo dose":"Costo unità","right", (p,cu)=>td(fmt(cu),"text-align:right")],
    mg:    [`<span title="Margine sul prezzo di vendita, tutto IVA esclusa.">Margine ⓘ</span>`,"right", (p,cu,mg)=>td(mg===null?"—":fmtN(mg,0)+"%",`text-align:right;color:${mg===null?"var(--txt4)":mg<65?"var(--orange)":"var(--green)"}`)],
    scorta:[`<span title="Sotto questa giacenza il prodotto compare in &quot;Da riordinare&quot;.">Scorta min. ⓘ</span>`,"left", p=>td(inp(p,"scortaMin",p.scortaMin,"1",60))],
    giac:  [cat==="birre"?"Giacenza pz":cat.startsWith("keg")?"Giacenza fusti":"Giacenza","right", p=>td(p.inArrivo? dash : _barPz(_barGiac(ix.get(p.id),t).g),"text-align:right")],
    att:   ["","right", p=>td(`<div style="display:flex;gap:4px;justify-content:flex-end">
      <button class="btn-outline btn-sm" title="Modifica scheda" onclick="barModificaProd('${h(p.id)}')">${ic("edit")}</button>
      <button class="btn-outline btn-sm" title="${p.attivo?"Nascondi dalle liste (resta nei conti)":"Riattiva"}" onclick="barSetProd('${h(p.id)}','attivo',${!p.attivo})">${p.attivo?ic("eye"):ic("refresh")}</button>
      <button class="btn-outline btn-sm" title="Elimina prodotto" onclick="barEliminaProd('${h(p.id)}')">${ic("trash")}</button></div>`,"text-align:right;white-space:nowrap")]
  };
  const keg = ["prod","forn","dosecl","resaP","nDosi","prezzo","costo","cu","mg","scorta","giac","att"];
  const cols = {
    spirits:["prod","forn","uso","dosecl","nDosi","prezzo","costo","cu","mg","scorta","giac","att"],
    birre:  _barFusti()? ["prod","forn","servizio","dosecl","resaP","nDosi","prezzo",...(_barSpina()?["prezzoP"]:[]),"costo","cu","mg","scorta","giac","att"] : ["prod","forn","prezzo","costo","mg","scorta","giac","att"],
    sodati: ["prod","forn","uso","prezzo","costo","mg","scorta","giac","att"],
    kegcocktail: keg, kegvino: keg
  }[cat] || ["prod","forn","unita","dosi","prezzo","costo","cu","mg","scorta","giac","att"];
  return `<div class="card" style="margin-bottom:16px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end">
      ${catSel}<div><label class="form-label">Cerca</label><input class="form-input" value="${h(barUi.q)}" onchange="barSet('q',this.value)" placeholder="nome, produttore, fornitore"></div>
      <div><button class="btn-outline btn-sm" onclick="barNuovoProd()">+ Prodotto non ordinato</button></div></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">I prodotti arrivano dagli ordini (anche quelli in arrivo). ${S? (cat==="birre"&&!_barFusti()? "Vendita a bottiglia/lattina: prezzo al pezzo." : S.hint) : "Scegli una categoria per la scheda dedicata."} ${S&&_barPrezzoDef(cat)? `Prezzo di vendita del locale: ${fmt(_barPrezzoDef(cat))}, vale per i prodotti senza un prezzo proprio. `:""}Prezzi di vendita IVA inclusa (come in carta); costo e margine IVA esclusa. Il costo si compila da solo dagli ordini: scrivilo solo per correggerlo, svuotalo per tornare al calcolo automatico.${cat==="birre"&&_barSpina()? ` Spina: media ${_barSpina().media.cl} cl a ${fmt(_barSpina().media.prezzo)}, piccola ${_barSpina().piccola.cl} cl a ${fmt(_barSpina().piccola.prezzo)} (modificabili per birra).`:""}</div></div>
    <div class="card" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:${cols.length*92}px"><thead><tr>
      ${cols.map(k=>th(C[k][0],C[k][1])).join("")}</tr></thead><tbody>
    ${prods.map(p=>{ const cu = p.dosi? p.costoNet/p.dosi : 0, pn = _barNet(p.prezzo), mg = pn&&!_barCock(p)? (1-cu/pn)*100 : null;
      return `<tr style="border-top:1px solid var(--border);${p.attivo?"":"opacity:.45"}">${cols.map(k=>C[k][2](p,cu,mg)).join("")}</tr>`; }).join("")
      || `<tr><td colspan="${cols.length}" style="padding:20px;text-align:center;color:var(--txt4)">Nessun prodotto. Crea un ordine bar oppure aggiungilo a mano.</td></tr>`}
    </tbody></table></div>`;
}
async function barSetProd(id, f, v){
  let p = _barProdotti().find(x=>x.id===id); if(!p) return;
  const wasSaved = p.saved, pid = _barEnsure(p), rec = bar.find(x=>x.id===pid);
  const fL = parseFloat(rec.formato)||0;
  if(f==="unita"){ rec.unita = v; const d=_barDefaults(rec.cat, rec.tipo, rec.formato);
    if(v==="bottiglia"||v==="pezzo") rec.dosi=1;
    else { rec.dosecl = parseFloat(rec.dosecl) || (v==="bicchiere"?(_barSpina()?.media.cl||40):4); rec.dosi = fL? Math.round(fL*100/rec.dosecl*10)/10 : (v===d.unita? d.dosi : 1); } }
  else if(f==="dosecl"){ const cl=Math.max(0,parseFloat(v)||0); rec.dosecl=cl; if(cl&&fL) rec.dosi=Math.round(fL*100/cl*10)/10; }
  else if(f==="uso") rec.uso = v==="cocktail"?"cocktail":"vendita";
  else if(f==="attivo") rec.attivo = !!v;
  else if(f==="costoNetto"){ rec.costoNetto = Math.max(0, parseFloat(String(v).replace(",","."))||0); delete rec.costo; }
  else if(f==="resa"){ const r=parseFloat(v)||0; if(r>0&&r<=100) rec.resa=r; else delete rec.resa; }
  else rec[f] = Math.max(0, parseFloat(String(v).replace(",","."))||0);
  if(!wasSaved || ["unita","attivo","dosecl","uso","resa","costoNetto"].includes(f)) render();
  await _barSave();
}
// ─── Modifica / elimina prodotto ─────────────────────────────────────────────
function barModificaProd(id){
  const p = _barProdotti().find(x=>x.id===id); if(!p) return;
  const tipi = ORD_CAT[p.cat]?.tipi||[], fmts = (typeof ORD_FMT!=="undefined" && ORD_FMT[p.cat]) || [];
  const fv = parseFloat(p.formato)||0;
  const fmtSel = fmts.length
    ? `<select id="bpm-formato" class="form-select">${fmts.some(a=>a[0]===fv)?"":`<option value="${fv}" selected>${fv} L</option>`}${fmts.map(([f,l])=>`<option value="${f}" ${f===fv?"selected":""}>${h(l)}</option>`).join("")}</select>`
    : `<input id="bpm-formato" type="number" step="0.01" class="form-input" value="${fv||""}">`;
  document.getElementById("bar-prod-modal")?.remove();
  const bd = document.createElement("div"); bd.id = "bar-prod-modal"; bd.className = "modal-backdrop";
  bd.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px";
  bd.onclick = () => bd.remove();
  const f = (lbl,html) => `<div><label class="form-label">${lbl}</label>${html}</div>`;
  bd.innerHTML = `<div class="modal" style="max-width:620px;width:100%" onclick="event.stopPropagation()">
    <div class="modal-header"><h2>${ic("edit")} Modifica prodotto</h2><button style="font-size:18px;color:var(--txt3)" onclick="document.getElementById('bar-prod-modal').remove()">${ic("x")}</button></div>
    <div class="modal-body"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      ${f("Nome *",`<input id="bpm-nome" class="form-input" value="${h(p.nome)}">`)}
      ${f("Produttore / marca",`<input id="bpm-produttore" class="form-input" value="${h(p.produttore)}">`)}
      ${f("Categoria",`<select id="bpm-cat" class="form-select">${Object.entries(ORD_CAT).map(([k,c])=>`<option value="${k}" ${p.cat===k?"selected":""}>${h(c.label)}</option>`).join("")}</select>`)}
      ${f("Tipologia",`<select id="bpm-tipo" class="form-select">${tipi.includes(p.tipo)?"":`<option selected>${h(p.tipo||"")}</option>`}${tipi.map(t=>`<option ${t===p.tipo?"selected":""}>${h(t)}</option>`).join("")}</select>`)}
      ${f("Formato",fmtSel)}
      ${f("% vol",`<input id="bpm-grad" type="number" step="0.1" class="form-input" value="${p.gradazione||""}">`)}
      ${p.cat==="spirits"?f("Età / affinamento",`<input id="bpm-eta" class="form-input" value="${h(p.eta||"")}">`):""}
      ${f("Fornitore",`<input id="bpm-forn" class="form-input" value="${h(p.fornitore||"")}">`)}
    </div><div style="font-size:12px;color:var(--txt4);margin-top:12px">Il collegamento con gli ordini resta invariato: conte, uscite e carichi già registrati non si perdono.</div></div>
    <div class="modal-footer"><button class="btn-outline" onclick="document.getElementById('bar-prod-modal').remove()">Annulla</button>
      <button class="btn-primary" onclick="barSalvaProd('${h(p.id)}')">Salva</button></div></div>`;
  document.body.appendChild(bd);
}
async function barSalvaProd(id){
  const p = _barProdotti().find(x=>x.id===id); if(!p) return;
  const v = k => (document.getElementById("bpm-"+k)?.value ?? "").trim();
  const nome = v("nome"); if(!nome){ notify("Il nome è obbligatorio","err"); return; }
  const rec = bar.find(x=>x.id===_barEnsure(p));
  const formato = parseFloat(String(v("formato")).replace(",","."))||0, cat = ORD_CAT[v("cat")]? v("cat") : rec.cat;
  Object.assign(rec, { nome, produttore:v("produttore"), cat, tipo:v("tipo")||rec.tipo, gradazione:parseFloat(String(v("grad")).replace(",","."))||"", fornitore:v("forn") });
  if(document.getElementById("bpm-eta")) rec.eta = v("eta");
  if(formato !== (parseFloat(rec.formato)||0)){
    rec.formato = formato;
    const d = _barDefaults(cat, rec.tipo, formato);
    if(rec.unita==="dose"||rec.unita==="bicchiere"){ const cl = parseFloat(rec.dosecl)||d.dosecl||4; rec.dosi = formato? Math.round(formato*100/cl*10)/10 : rec.dosi; }
    if(rec.resa && !_barIsFusto(rec.unita, formato)) delete rec.resa;
  }
  document.getElementById("bar-prod-modal")?.remove();
  notify("Prodotto aggiornato"); render(); await _barSave(); if(section==="bar") render();
}
async function barEliminaProd(id){
  const p = _barProdotti().find(x=>x.id===id); if(!p) return;
  const pid = p.saved? p.id : null;
  const nMov = pid? bar.filter(x=>(x.t==="m"||x.t==="c") && x.pid===pid).length : 0;
  const daOrdini = _barCarichi().some(c=>c.key===p.key) || p.inArrivo || p.inOrdine;
  const nCock = pid? bar.filter(x=>x.t==="k" && (x.ingr||[]).some(g=>g.pid===pid)).length : 0;
  const msg = `Eliminare "${p.nome}"?` + (nMov? `\n• Verranno cancellate anche ${nMov} tra conte e uscite registrate.` : "")
    + (nCock? `\n• Verrà tolto da ${nCock} ricett${nCock===1?"a":"e"} cocktail.` : "")
    + (daOrdini? "\n• Gli ordini restano nello storico e nella spesa; il prodotto non comparirà più nel Bar." : "");
  if(!confirm(msg)) return;
  if(pid){ bar = bar.filter(x=>!((x.t==="m"||x.t==="c") && x.pid===pid));
    bar.forEach(k=>{ if(k.t==="k") (k.ingr||[]).forEach(g=>{ if(g.pid===pid) g.pid=""; }); }); }
  if(daOrdini){ const rid = _barEnsure(p), rec = bar.find(x=>x.id===rid); rec.eliminato = true; rec.attivo = false; }
  else if(pid) bar = bar.filter(x=>x.id!==pid);
  notify(`${p.nome} eliminato`); render(); await _barSave(); if(section==="bar") render();
}
async function barNuovoProd(){
  const cat = (prompt("Categoria: "+Object.keys(ORD_CAT).join(", "), ORD_CAT[barUi.cat]? barUi.cat : "spirits")||"").trim().toLowerCase();
  if(!ORD_CAT[cat]){ if(cat) notify("Categoria non valida","err"); return; }
  const nome = (prompt("Nome prodotto")||"").trim(); if(!nome) return;
  const produttore = (prompt("Produttore (facoltativo)")||"").trim();
  const formato = parseFloat(String(prompt("Formato in litri (es. 0.7, 0.33, 20)","0.7")||"").replace(",","."))||0;
  const tipo = ORD_CAT[cat].tipi[0], d = _barDefaults(cat, tipo, formato);
  const key = _barKey(produttore, nome, formato);
  if(bar.some(x=>x.t==="p"&&x.key===key) || _barCarichi().some(c=>c.key===key)){ notify("Prodotto già presente","err"); return; }
  bar.push({ id:uid(), t:"p", key, cat, nome, produttore, formato, tipo, unita:d.unita, dosi:d.dosi, dosecl:d.dosecl||0, uso:"vendita", prezzo:0, attivo:true });
  render(); await _barSave();
}

// ─── Ricezione ordini bar: referenza non prevista (scheda breve, non quella vino) ─
function _ricAddBarRow(editId){
  if(!ricezioneModalData) return;
  const o = orders.find(x=>x.id===ricezioneModalData.ordineId), cat = _ordCat(o); if(!cat) return;
  const ex = editId? ricezioneModalData.righe.find(x=>x.id===editId) : null;
  const ask = (q,d) => { const r = prompt(q, d ?? ""); return r===null? null : r.trim(); };
  const nome = ask("Nome prodotto", ex?.nomeVino); if(!nome) return;
  const produttore = ask("Produttore / marca", ex?.produttore); if(produttore===null) return;
  const formato = parseFloat(String(ask("Formato in litri (es. 0.7 · 0.33 · 20)", ex?.formato ?? (typeof ORD_FMT_DEF!=="undefined"? ORD_FMT_DEF[cat] : ""))||"").replace(",","."))||0;
  const prezzoAcq = parseFloat(String(ask("Prezzo d'acquisto a pezzo, IVA esclusa", ex?.prezzoAcq)||"").replace(",","."))||0;
  const qtyArr = parseInt(ask("Pezzi arrivati", ex?.qtyArr ?? 1))||0;
  if(qtyArr<=0){ notify("Indica quanti pezzi sono arrivati","err"); return; }
  const dati = { produttore, nomeVino:nome, formato, tipologia:ex?.tipologia||ORD_CAT[cat].tipi[0], nazione:ex?.nazione||"", prezzoAcq, iva:22, prezzoCarta:0, qty:0, qtyArr, _extra:true };
  if(ex) Object.assign(ex,dati); else ricezioneModalData.righe.push({ id:uid(), ...dati });
  _ricRenderRighe();
  notify(`${nome} ${ex?"aggiornato":"aggiunto alla ricezione"}`);
}
