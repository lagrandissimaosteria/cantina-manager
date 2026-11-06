/* documenti.js — Amministrazione › Documenti emessi: Fatture (TD01), Fatture differite (TD24),
   Note di credito (TD04) e DDT. Identico per tutti i locali (differenze solo da CONFIG / dati fatturazione).
   Dipende da manager.js (wines, CONFIG, localeData, _sb, _effectiveDbUser, _merge3, _lsKey, _printHtml,
   h, fmt, fmtN, today, uid, notify, ic, render, _fmtDataIT, renderAmministrazione) e opz. da bar.js (_barProdotti).
   Dati: blob cm_documenti (user_id, data jsonb[]) — record misti con id:
     t:"cli" cliente   {rs,nome,cognome,piva,cf,ind,cap,citta,prov,naz,sdi,pec,email,tel,dest}
     t:"doc" documento {tipo:"fattura"|"nc"|"ddt",td,num,anno,data,cli:{…},righe:[…],…}
     id:"cfg" impostazioni {sez,iban,banca,regime,rea*,ivaDef,pagMod,pagTerm,note}
   Numerazione: progressiva per anno; fatture e note di credito condividono la serie, i DDT hanno la propria.
   Sezionale per locale (default dal prefisso SKU: LG, PT) → niente doppioni tra locali con la stessa P.IVA. */
"use strict";
var docs = [], _docsBase = [], _docsTableOk = true, _docsLoaded = false, _docsLoading = false;
var docUi = { tab:"fornitori", tipo:"tutti", anno:String(new Date().getFullYear()), q:"", sel:new Set(), pickQ:"", listino:"acq", ricarico:0, cliEdit:null };
var dcDraft = null;

const DC_TIPI = { fattura:{lbl:"Fattura", td:"TD01"}, diff:{lbl:"Fattura differita", td:"TD24"}, nc:{lbl:"Nota di credito", td:"TD04"}, ddt:{lbl:"DDT", td:""} };
const DC_NATURE = {
  "N1":"Escluse ex art. 15 DPR 633/72", "N2.1":"Non soggette art. 7-7septies DPR 633/72", "N2.2":"Non soggette - altri casi",
  "N3.1":"Non imponibili - esportazioni art. 8 DPR 633/72", "N3.2":"Non imponibili - cessioni intracomunitarie art. 41 DL 331/93",
  "N3.5":"Non imponibili - dichiarazione d'intento art. 8 c.1 lett. c DPR 633/72", "N4":"Esenti art. 10 DPR 633/72"
};
const DC_NAT_BOLLO = new Set(["N1","N2.1","N2.2","N3.1","N3.5","N4"]);
const DC_PAG = { MP05:"Bonifico", MP01:"Contanti", MP08:"Carta di pagamento", MP02:"Assegno", MP12:"RIBA", MP19:"SEPA Direct Debit" };
const DC_TERM = { vista:"A vista", "30df":"30 gg data fattura", "30fm":"30 gg d.f. fine mese", "60df":"60 gg data fattura", "60fm":"60 gg d.f. fine mese", "90fm":"90 gg d.f. fine mese", data:"Data specifica" };
const DC_CAUS = ["Vendita","Conto visione","Conto deposito","Reso a fornitore","Omaggio","Campionatura","Trasferimento tra sedi"];
const DC_CURA = ["Mittente","Destinatario","Vettore"];
const DC_ASP = ["Cartoni","Casse in legno","Pallet","Sfuso","Confezioni regalo"];
const DC_REGIMI = { RF01:"Ordinario", RF19:"Forfettario", RF02:"Contribuenti minimi" };

const _dcR2 = n => Math.round(((parseFloat(n)||0)+Number.EPSILON)*100)/100;
const _dcNum = v => parseFloat(String(v??"").replace(",","."))||0;
const _dcIt = n => fmtN(n,2);
const _dcCfg = () => docs.find(x=>x.id==="cfg") || { id:"cfg" };
const _dcSez = () => (_dcCfg().sez ?? String((typeof CONFIG!=="undefined"&&CONFIG.skuPrefix)||"").replace(/[^A-Za-z0-9]/g,"")).toUpperCase();
const _dcDocs = () => docs.filter(x=>x.t==="doc");
const _dcCli = () => docs.filter(x=>x.t==="cli").sort((a,b)=>String(a.rs||"").localeCompare(String(b.rs||""),"it"));
const _dcSerie = tipo => tipo==="ddt" ? "ddt" : "fatt";
const _dcNumLbl = d => d.num ? `${d.num}${d.sez?"/"+d.sez:""}` : "—";
const _dcCliNome = c => (c&&(c.rs || [c.nome,c.cognome].filter(Boolean).join(" ")))||"";
const _dcCedente = () => {
  const l = (typeof localeData!=="undefined"&&localeData)||{};
  return { rs:(typeof _ragione==="function"?_ragione(l):l.ragioneSociale)||"", ind:l.sedeIndirizzo||l.indirizzo||"", cap:l.sedeCap||l.cap||"",
    citta:l.sedeCitta||l.citta||"", prov:l.sedeProvincia||l.provincia||"", piva:String(l.piva||"").replace(/\s/g,""), cf:String(l.cf||l.piva||"").replace(/\s/g,""),
    sdi:l.sdi||"", pec:l.pec||"", email:l.email||"", tel:l.telefono||"", consegna:[l.indirizzo,l.cap,l.citta,l.provincia].filter(Boolean).join(" ") };
};

// ─── Persistenza (pattern cm_bar / cm_fatture) ───────────────────────────────
async function _docsRead(){
  if(!_sb) return { _missing:true };
  try{
    const { data, error } = await _sb.from("cm_documenti").select("data").eq("user_id", _effectiveDbUser());
    if(error){ _docsTableOk=false; return { _missing:true }; }
    _docsTableOk=true; return (data&&data[0]&&data[0].data) || [];
  }catch{ _docsTableOk=false; return { _missing:true }; }
}
function _docsCache(){ try{ localStorage.setItem(_lsKey("documenti"), JSON.stringify(docs)); }catch{} }
async function _loadDocs(){
  if(_docsLoading) return; _docsLoading=true;
  const r = await _docsRead();
  let loc=[]; try{ loc=JSON.parse(localStorage.getItem(_lsKey("documenti"))||"[]"); }catch{}
  if(r && r._missing) docs = Array.isArray(loc)?loc:[];
  else if(!r.length && Array.isArray(loc) && loc.length){ docs=loc; _docsBase=[]; await _docsSave(true); }
  else docs = r;
  _docsBase = JSON.parse(JSON.stringify(docs)); _docsLoaded=true; _docsLoading=false;
}
async function _docsSave(skipRebase){
  _docsCache();
  if(!_sb || !_docsTableOk) return;
  try{
    if(!skipRebase){ const r=await _docsRead(); if(r && !r._missing && Array.isArray(r)) docs=_merge3(_docsBase, docs, r); }
    const { error } = await _sb.from("cm_documenti").upsert(
      { user_id:_effectiveDbUser(), data:JSON.parse(JSON.stringify(docs)), updated_at:new Date().toISOString() }, { onConflict:"user_id" });
    if(error){ notify("Documenti: salvataggio cloud non riuscito, tenuti in locale","err"); return; }
    _docsBase = JSON.parse(JSON.stringify(docs)); _docsCache();
  }catch{ notify("Documenti: rete assente, tenuti in locale","err"); }
}
function _dcPut(rec){ const i=docs.findIndex(x=>x.id===rec.id); if(i>=0) docs[i]=rec; else docs.push(rec); }

// ─── Calcoli ─────────────────────────────────────────────────────────────────
function _dcNextNum(tipo, anno){
  const s=_dcSerie(tipo);
  return _dcDocs().filter(d=>_dcSerie(d.tipo)===s && String(d.anno)===String(anno)).reduce((m,d)=>Math.max(m,parseInt(d.num)||0),0)+1;
}
function _dcScad(d){
  const t=d.pagTerm||"vista"; if(t==="data") return d.pagScad||d.data;
  if(t==="vista") return d.data;
  const gg=parseInt(t), fm=t.endsWith("fm"), dt=new Date((d.data||today())+"T12:00:00");
  dt.setDate(dt.getDate()+gg); if(fm) dt.setMonth(dt.getMonth()+1,0);
  return dt.toISOString().slice(0,10);
}
function _dcRigaTot(r){ return _dcR2(_dcNum(r.qty)*_dcNum(r.prezzo)*(1-_dcNum(r.sconto)/100)); }
function _dcCalc(d){
  const righe=(d.righe||[]).map(r=>({...r}));
  const nat0 = righe.filter(r=>!_dcNum(r.iva) && DC_NAT_BOLLO.has(r.natura)).reduce((s,r)=>s+_dcRigaTot(r),0);
  const bollo = d.tipo==="ddt" ? false : d.bollo==="si" ? true : d.bollo==="no" ? false : nat0>77.47;
  if(bollo && d.bolloAddeb) righe.push({ desc:"Imposta di bollo assolta in modo virtuale", qty:1, prezzo:2, iva:0, natura:"N1", um:"", _bollo:true });
  const riep={};
  righe.forEach(r=>{
    const aliq=_dcNum(r.iva), nat=aliq?"":(r.natura||"N2.2"), k=aliq+"|"+nat;
    (riep[k] ||= { aliq, nat, imp:0, rif:nat?(d.rifNorm?.[nat]||DC_NATURE[nat]||""):"" }).imp += _dcRigaTot(r);
  });
  const rr=Object.values(riep).map(x=>({ ...x, imp:_dcR2(x.imp), iva:_dcR2(x.imp*x.aliq/100) })).sort((a,b)=>b.aliq-a.aliq);
  const imp=_dcR2(rr.reduce((s,x)=>s+x.imp,0)), iva=_dcR2(rr.reduce((s,x)=>s+x.iva,0));
  const split = d.esig==="S";
  return { righe, riep:rr, imp, iva, bollo, totale:_dcR2(imp+iva), netto:_dcR2(imp+(split?0:iva)), pezzi:righe.filter(r=>!r._bollo).reduce((s,r)=>s+_dcNum(r.qty),0) };
}

// ─── Referenze per menù a tendina ────────────────────────────────────────────
function _dcFmtCl(f){ const v=parseFloat(f)||0; return v? (v<1? Math.round(v*100)+" cl" : fmtN(v,2).replace(/,00$/,"")+" L") : ""; }
function _dcRefs(){
  const out=[];
  (typeof wines!=="undefined"?wines:[]).forEach(w=>{
    const g=parseInt(w.giacenza)||0;
    out.push({ v:"w:"+w.id, grp:g>0?"Vini in giacenza":"Vini esauriti", g, cod:w.sku||"",
      desc:[w.produttore, w.nome, w.annata, _dcFmtCl(w.formato||0.75)].filter(Boolean).join(" "),
      acq:parseFloat(w.prezzoAcq)||0, carta:parseFloat(w.prezzoCarta)||0, um:"BT",
      cerca:[w.produttore,w.nome,w.annata,w.sku,w.regione,w.tipologia].join(" ").toLowerCase() });
  });
  if(typeof _barProdotti==="function"){ try{ _barProdotti().filter(p=>p.attivo!==false).forEach(p=>out.push({ v:"b:"+p.key, grp:"Bar", g:null, cod:"",
    desc:[p.produttore,p.nome,_dcFmtCl(p.formato)].filter(Boolean).join(" "), acq:parseFloat(p.costoNet)||0, carta:0, um:"PZ",
    cerca:[p.produttore,p.nome,p.tipo,p.cat].join(" ").toLowerCase() })); }catch{} }
  return out;
}
function _dcPickOpts(){
  const q=docUi.pickQ.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const list=_dcRefs().filter(r=>q.every(t=>r.cerca.includes(t)))
    .sort((a,b)=>(a.grp>b.grp?1:a.grp<b.grp?-1:0)||a.desc.localeCompare(b.desc,"it")).slice(0,400);
  const grp={}; list.forEach(r=>(grp[r.grp] ||= []).push(r));
  const order=["Vini in giacenza","Bar","Vini esauriti"];
  return `<option value="">— Seleziona referenza (${list.length}${list.length===400?"+":""}) —</option>`+
    order.filter(g=>grp[g]).map(g=>`<optgroup label="${g}">${grp[g].map(r=>`<option value="${h(r.v)}">${h(r.desc)}${r.cod?" · "+h(r.cod):""}${r.g!=null?" · giac. "+r.g:""}</option>`).join("")}</optgroup>`).join("");
}
function _dcPickFilter(v){ docUi.pickQ=v; const s=document.getElementById("dc-pick"); if(s) s.innerHTML=_dcPickOpts(); }

// ─── Bozza documento ─────────────────────────────────────────────────────────
function _dcNuovoDoc(tipo, base){
  const c=_dcCfg(), anno=String(new Date().getFullYear());
  return Object.assign({ id:uid(), t:"doc", _nuovo:true, tipo, td:DC_TIPI[tipo].td, anno, num:_dcNextNum(tipo,anno), sez:_dcSez(), data:today(),
    cli:{ naz:"IT" }, righe:[], esig:"I", bollo:"auto", bolloAddeb:false,
    pagMod:c.pagMod||"MP05", pagTerm:c.pagTerm||"30df", pagScad:"", iban:c.iban||"", banca:c.banca||"", pagata:false,
    causale:"", note:c.note||"", ddtRif:[], fattRif:null,
    causTr:"Vendita", cura:"Mittente", vettore:"", dataTr:today(), oraTr:"", colli:"", peso:"", aspetto:"Cartoni", porto:"Franco", prezziDdt:false, destDiv:false, dest:"" }, base||{});
}
function dcNuovo(tipo){ dcDraft=_dcNuovoDoc(tipo); docUi.tab="emessi"; render(); _dcTop(); }
function dcModifica(id){ const d=docs.find(x=>x.id===id); if(!d) return; dcDraft=JSON.parse(JSON.stringify(d)); docUi.tab="emessi"; render(); _dcTop(); }
function dcDuplica(id){ const d=docs.find(x=>x.id===id); if(!d) return;
  const c=JSON.parse(JSON.stringify(d)); delete c.fattId; delete c.invii;
  dcDraft=_dcNuovoDoc(d.tipo,{ ...c, id:uid(), _nuovo:true, data:today(), anno:String(new Date().getFullYear()), num:_dcNextNum(d.tipo,new Date().getFullYear()), pagata:false, ddtRif:[] });
  render(); _dcTop(); }
function dcNotaCredito(id){ const f=docs.find(x=>x.id===id); if(!f) return;
  dcDraft=_dcNuovoDoc("nc",{ cli:{...f.cli}, righe:JSON.parse(JSON.stringify(f.righe||[])), esig:f.esig, fattRif:{id:f.id,num:_dcNumLbl(f),data:f.data},
    causale:`Storno ${f.tipo==="nc"?"nota":"fattura"} n. ${_dcNumLbl(f)} del ${_fmtDataIT(f.data)}`, pagTerm:"vista" });
  render(); _dcTop(); }
function dcAnnulla(){ dcDraft=null; render(); }
function _dcTop(){ try{ document.getElementById("dc-form")?.scrollIntoView({behavior:"smooth",block:"start"}); }catch{} }
function _dcSet(path, v, rerender){
  const ks=path.split("."); let o=dcDraft; for(let i=0;i<ks.length-1;i++) o=(o[ks[i]] ||= {});
  o[ks.at(-1)]=v;
  if(path==="anno"||path==="tipo"){ /* numero resta quello proposto, modificabile */ }
  if(rerender) render(); else _dcRecalc();
}
function _dcSetCliente(id){
  if(!id) return;
  const c=docs.find(x=>x.id===id); if(!c) return;
  const { t, ...cli } = JSON.parse(JSON.stringify(c)); dcDraft.cli={ ...cli, _id:id };
  if(c.dest){ dcDraft.destDiv=true; dcDraft.dest=c.dest; }
  if(c.pagMod) dcDraft.pagMod=c.pagMod; if(c.pagTerm) dcDraft.pagTerm=c.pagTerm;
  render();
}
function dcSalvaClienteDaDoc(){
  const c=dcDraft.cli||{}; if(!_dcCliNome(c)){ notify("Inserisci almeno la ragione sociale","err"); return; }
  const id=c._id || docs.find(x=>x.t==="cli" && ((c.piva&&x.piva===c.piva) || (!c.piva && x.rs===c.rs)))?.id || uid();
  const { _id, ...dati } = c; _dcPut({ ...dati, id, t:"cli", dest:dcDraft.destDiv?dcDraft.dest:"", pagMod:dcDraft.pagMod, pagTerm:dcDraft.pagTerm });
  dcDraft.cli._id=id; _docsSave(); notify("Cliente salvato in rubrica"); render();
}
function dcAggiungiRef(){
  const sel=document.getElementById("dc-pick"), v=sel?.value; if(!v){ notify("Seleziona una referenza dal menù","err"); return; }
  const r=_dcRefs().find(x=>x.v===v); if(!r) return;
  const qty=_dcNum(document.getElementById("dc-pick-qty")?.value)||1, ivaDef=_dcNum(_dcCfg().ivaDef??22);
  const ric=_dcNum(docUi.ricarico);
  const prezzo = docUi.listino==="carta" ? _dcR2(r.carta/(1+ivaDef/100)) : docUi.listino==="acq" ? _dcR2(r.acq*(1+ric/100)) : 0;
  const ex=dcDraft.righe.find(x=>x.ref===v && _dcNum(x.prezzo)===prezzo);
  if(ex) ex.qty=_dcNum(ex.qty)+qty;
  else dcDraft.righe.push({ rid:uid(), ref:v, cod:r.cod, desc:r.desc, qty, um:r.um, prezzo, sconto:0, iva:ivaDef, natura:"" });
  if(r.g!=null && qty>r.g) notify(`Attenzione: giacenza ${r.g}, richieste ${qty}`,"err");
  render();
}
function dcRigaLibera(){ dcDraft.righe.push({ rid:uid(), ref:"", cod:"", desc:"", qty:1, um:"PZ", prezzo:0, sconto:0, iva:_dcNum(_dcCfg().ivaDef??22), natura:"" }); render(); }
function dcRigaDel(i){ dcDraft.righe.splice(i,1); render(); }
function dcRigaSu(i){ if(i<1) return; const r=dcDraft.righe; [r[i-1],r[i]]=[r[i],r[i-1]]; render(); }
function _dcRow(i,k,v,rerender){ const r=dcDraft.righe[i]; if(!r) return; r[k]=v; if(k==="iva" && _dcNum(v)===0 && !r.natura) r.natura="N2.2"; if(rerender) render(); else _dcRecalc(); }
function _dcRecalc(){
  if(!dcDraft) return; const c=_dcCalc(dcDraft);
  dcDraft.righe.forEach((r,i)=>{ const el=document.getElementById("dc-rt-"+i); if(el) el.textContent=_dcIt(_dcRigaTot(r)); });
  const t=document.getElementById("dc-tot"); if(t) t.innerHTML=_dcTotHtml(c);
}
function _dcTotHtml(c){
  const d=dcDraft, ddt=d.tipo==="ddt";
  if(ddt) return `<div style="font-size:13px;color:var(--txt2)">${fmtN(c.pezzi,0)} pezzi${d.prezziDdt?` · imponibile ${fmt(c.imp)} · totale ${fmt(c.totale)}`:""}</div>`;
  return `<table style="width:100%;font-size:13px"><tr style="color:var(--txt3)"><td>Aliquota</td><td class="r">Imponibile</td><td class="r">Imposta</td></tr>
    ${c.riep.map(x=>`<tr><td>${x.aliq?x.aliq+"%":x.nat}</td><td class="r">${fmt(x.imp)}</td><td class="r">${fmt(x.iva)}</td></tr>`).join("")}
    <tr style="border-top:1px solid var(--border)"><td><strong>Totale documento</strong></td><td class="r">${fmt(c.imp)}</td><td class="r">${fmt(c.iva)}</td></tr>
    <tr><td colspan="3" class="r" style="font-family:'Montserrat',sans-serif;font-size:1.25rem;padding-top:6px">${fmt(c.totale)}</td></tr>
    ${d.esig==="S"?`<tr><td colspan="3" class="r" style="color:var(--txt3)">Split payment · netto a pagare ${fmt(c.netto)}</td></tr>`:""}
    ${c.bollo?`<tr><td colspan="3" class="r" style="color:var(--orange)">Bollo virtuale 2,00 €${d.bolloAddeb?" (addebitato)":" (a carico emittente)"}</td></tr>`:""}
    <tr><td colspan="3" class="r" style="color:var(--txt3)">Scadenza ${_fmtDataIT(_dcScad(d))}</td></tr></table>`;
}
function _dcValida(d){
  const e=[], c=d.cli||{}, ced=_dcCedente();
  if(!_dcCliNome(c)) e.push("Cliente: ragione sociale o nome e cognome");
  if(!d.righe.length) e.push("Almeno una riga");
  if(!d.num) e.push("Numero documento");
  const dup=_dcDocs().find(x=>x.id!==d.id && _dcSerie(x.tipo)===_dcSerie(d.tipo) && String(x.anno)===String(d.anno) && String(x.num)===String(d.num) && (x.sez||"")===(d.sez||""));
  if(dup) e.push(`Numero ${_dcNumLbl(d)} già usato nel ${d.anno}`);
  if(d.tipo!=="ddt"){
    if(!ced.piva) e.push("Dati fatturazione del locale (Impostazioni): P.IVA mancante");
    if(!c.piva && !c.cf) e.push("Cliente: P.IVA o codice fiscale");
    d.righe.forEach((r,i)=>{ if(!_dcNum(r.iva) && !r.natura) e.push(`Riga ${i+1}: natura IVA per aliquota 0`); if(!String(r.desc||"").trim()) e.push(`Riga ${i+1}: descrizione`); });
  }
  return e;
}
async function dcSalva(stampa){
  const d=dcDraft; const err=_dcValida(d);
  if(err.length){ notify(err[0],"err"); alert("Da completare:\n• "+err.join("\n• ")); return; }
  if(String(d.anno)!==String(d.data||"").slice(0,4)) d.anno=String(d.data).slice(0,4);
  const nuovo=d._nuovo; delete d._nuovo; d.td=DC_TIPI[d.tipo].td; d.pagScadCalc=_dcScad(d); d.agg=new Date().toISOString();
  d.totale=_dcCalc(d).totale;
  _dcPut(JSON.parse(JSON.stringify(d)));
  if(d.tipo==="diff") (d.ddtRif||[]).forEach(x=>{ const t=docs.find(y=>y.id===x.id); if(t) t.fattId=d.id; });
  if(d.cli && _dcCliNome(d.cli) && !d.cli._id && !_dcCli().some(x=>(d.cli.piva&&x.piva===d.cli.piva)||x.rs===d.cli.rs)){
    const { _id, ...cli } = d.cli; _dcPut({ ...cli, id:uid(), t:"cli", dest:d.destDiv?d.dest:"" });
  }
  dcDraft=null; await _docsSave(); notify(`${DC_TIPI[d.tipo].lbl} ${_dcNumLbl(d)} ${nuovo?"creata":"aggiornata"}`); render();
  if(stampa) dcStampa(d.id);
}
function dcElimina(id){
  const d=docs.find(x=>x.id===id); if(!d) return;
  if(d.fattId){ alert("DDT già fatturato: elimina prima la fattura differita collegata."); return; }
  const ultimo = _dcNextNum(d.tipo,d.anno)-1===parseInt(d.num);
  if(!confirm(`Eliminare ${DC_TIPI[d.tipo].lbl} ${_dcNumLbl(d)}?${ultimo?"":"\n\nNON è l'ultimo numero della serie: resterà un buco nella numerazione."}`)) return;
  if(d.tipo==="diff") docs.forEach(x=>{ if(x.fattId===d.id) delete x.fattId; });
  docs=docs.filter(x=>x.id!==id); _docsSave(); render();
}
function dcPagata(id){ const d=docs.find(x=>x.id===id); if(!d) return; d.pagata=!d.pagata; d.dataPag=d.pagata?today():""; _docsSave(); render(); }
function dcToggleSel(id,on){ on?docUi.sel.add(id):docUi.sel.delete(id); render(); }
function dcFatturaDaDdt(){
  const sel=[...docUi.sel].map(id=>docs.find(x=>x.id===id)).filter(d=>d&&d.tipo==="ddt"&&!d.fattId);
  if(!sel.length){ notify("Seleziona uno o più DDT da fatturare","err"); return; }
  const k=d=>(d.cli?.piva||_dcCliNome(d.cli)).toLowerCase();
  if(new Set(sel.map(k)).size>1){ alert("I DDT selezionati sono intestati a clienti diversi."); return; }
  sel.sort((a,b)=>String(a.data).localeCompare(String(b.data)));
  const righe=[]; sel.forEach(d=>(d.righe||[]).forEach(r=>righe.push({ ...r, rid:uid(), ddt:_dcNumLbl(d) })));
  dcDraft=_dcNuovoDoc("diff",{ cli:{...sel[0].cli}, righe, ddtRif:sel.map(d=>({ id:d.id, num:_dcNumLbl(d), data:d.data })),
    causale:"Fattura differita rif. DDT "+sel.map(d=>`n. ${_dcNumLbl(d)} del ${_fmtDataIT(d.data)}`).join(", ") });
  docUi.sel.clear(); render(); _dcTop();
  if(righe.some(r=>!_dcNum(r.prezzo))) notify("Alcune righe dei DDT non hanno prezzo: completale","err");
}

// ─── Render ──────────────────────────────────────────────────────────────────
const _dcInp = (lbl,path,val,extra="") => `<div><label class="form-label">${lbl}</label><input class="form-input" value="${h(val??"")}" oninput="_dcSet('${path}',this.value)" ${extra}></div>`;
const _dcSel = (lbl,path,val,opts,rer) => `<div><label class="form-label">${lbl}</label><select class="form-select" onchange="_dcSet('${path}',this.value,${rer?"true":"false"})">${Object.entries(opts).map(([k,v])=>`<option value="${h(k)}" ${String(val)===String(k)?"selected":""}>${h(v)}</option>`).join("")}</select></div>`;
const _dcArr = a => Object.fromEntries(a.map(x=>[x,x]));
const _dcGrid = (inner,min=160) => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(${min}px,1fr));gap:10px;margin-bottom:12px">${inner}</div>`;
const _dcLbl = t => `<div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--txt3);margin:14px 0 8px">${t}</div>`;

function _dcRenderForm(){
  const d=dcDraft, c=d.cli||{}, ddt=d.tipo==="ddt", cli=_dcCli(), calc=_dcCalc(d);
  const tipiOpt = d._nuovo ? (ddt? {ddt:"DDT"} : {fattura:"Fattura (TD01)", diff:"Fattura differita (TD24)", nc:"Nota di credito (TD04)"}) : {[d.tipo]:DC_TIPI[d.tipo].lbl};
  const ivaOpt = r => `<select class="form-select" style="min-width:68px" onchange="_dcRow(${r.i},'iva',this.value,true)">${[22,10,5,4,0].map(a=>`<option value="${a}" ${_dcNum(r.iva)===a?"selected":""}>${a}%</option>`).join("")}</select>
    ${!_dcNum(r.iva)?`<select class="form-select" style="margin-top:4px;min-width:68px" title="Natura" onchange="_dcRow(${r.i},'natura',this.value)">${Object.keys(DC_NATURE).map(n=>`<option ${r.natura===n?"selected":""}>${n}</option>`).join("")}</select>`:""}`;
  const righe = d.righe.map((r,i)=>`<tr>
      <td style="min-width:240px"><input class="form-input" value="${h(r.desc)}" oninput="_dcRow(${i},'desc',this.value)">
        ${r.cod||r.ddt?`<div style="font-size:11px;color:var(--txt4);margin-top:2px">${h([r.cod,r.ddt?"DDT "+r.ddt:""].filter(Boolean).join(" · "))}</div>`:""}</td>
      <td><input class="form-input" style="width:70px" inputmode="decimal" value="${h(r.qty)}" oninput="_dcRow(${i},'qty',this.value)"></td>
      <td><input class="form-input" style="width:56px" value="${h(r.um)}" oninput="_dcRow(${i},'um',this.value.toUpperCase())"></td>
      ${!ddt||d.prezziDdt?`<td><input class="form-input" style="width:92px" inputmode="decimal" value="${h(r.prezzo)}" oninput="_dcRow(${i},'prezzo',this.value)"></td>
      <td><input class="form-input" style="width:60px" inputmode="decimal" value="${h(r.sconto||"")}" placeholder="0" oninput="_dcRow(${i},'sconto',this.value)"></td>
      <td>${ivaOpt({...r,i})}</td><td class="r" id="dc-rt-${i}" style="white-space:nowrap">${_dcIt(_dcRigaTot(r))}</td>`:""}
      <td style="white-space:nowrap"><button class="btn-outline btn-sm" onclick="dcRigaSu(${i})" title="Sposta su">↑</button>
        <button class="btn-outline btn-sm" onclick="dcRigaDel(${i})" title="Rimuovi">${ic("trash")}</button></td></tr>`).join("");

  return `<div id="dc-form" class="card" style="margin-bottom:16px;border-left:3px solid var(--amber)">
    <div class="section-label"><span>${ic(ddt?"truck":"receipt")} ${d._nuovo?"Nuovo documento":"Modifica"} · ${DC_TIPI[d.tipo].lbl} n. ${h(_dcNumLbl(d))}</span></div>
    ${_dcGrid(`${_dcSel("Tipo documento","tipo",d.tipo,tipiOpt,true)}
      ${_dcInp("Numero","num",d.num,'inputmode="numeric" style="max-width:120px"')}
      ${_dcInp("Sezionale","sez",d.sez,'style="max-width:90px" title="Distingue la numerazione di ogni locale"')}
      <div><label class="form-label">Data</label><input type="date" class="form-input" value="${h(d.data)}" onchange="_dcSet('data',this.value,true)"></div>
      ${d.tipo==="nc"&&d.fattRif?`<div><label class="form-label">Rif. fattura</label><div style="padding:8px 0;color:var(--txt2)">n. ${h(d.fattRif.num)} del ${_fmtDataIT(d.fattRif.data)}</div></div>`:""}`,140)}
    ${d.tipo==="diff"&&d.ddtRif?.length?`<div style="font-size:12px;color:var(--txt3);margin-bottom:8px">DDT collegati: ${d.ddtRif.map(x=>`n. ${h(x.num)} del ${_fmtDataIT(x.data)}`).join(" · ")} — la fattura differita va emessa entro il 15 del mese successivo alla consegna.</div>`:""}

    ${_dcLbl(ddt?"Destinatario":"Cliente (cessionario)")}
    ${_dcGrid(`<div><label class="form-label">Da rubrica</label><select class="form-select" onchange="_dcSetCliente(this.value)">
        <option value="">— ${cli.length?"Seleziona cliente salvato":"Rubrica vuota"} —</option>${cli.map(x=>`<option value="${x.id}" ${c._id===x.id?"selected":""}>${h(_dcCliNome(x))}${x.piva?" · "+h(x.piva):""}</option>`).join("")}</select></div>
      ${_dcInp("Ragione sociale *","cli.rs",c.rs)}
      ${_dcInp("Nome (se privato)","cli.nome",c.nome)}${_dcInp("Cognome","cli.cognome",c.cognome)}`)}
    ${_dcGrid(`${_dcInp("P.IVA","cli.piva",c.piva,'maxlength="28"')}${_dcInp("Codice fiscale","cli.cf",c.cf,'maxlength="16" style="text-transform:uppercase"')}
      ${_dcInp("Codice SDI","cli.sdi",c.sdi,'maxlength="7" placeholder="0000000" style="text-transform:uppercase"')}${_dcInp("PEC","cli.pec",c.pec)}`)}
    ${_dcGrid(`${_dcInp("Indirizzo sede","cli.ind",c.ind)}${_dcInp("CAP","cli.cap",c.cap,'maxlength="5" inputmode="numeric"')}
      ${_dcInp("Comune","cli.citta",c.citta)}${_dcInp("Prov.","cli.prov",c.prov,'maxlength="2" style="text-transform:uppercase"')}${_dcInp("Nazione","cli.naz",c.naz||"IT",'maxlength="2" style="text-transform:uppercase"')}`,110)}
    ${_dcGrid(`${_dcInp("Email","cli.email",c.email)}${_dcInp("Telefono","cli.tel",c.tel)}
      <div style="display:flex;align-items:flex-end"><button class="btn-outline btn-sm" onclick="dcSalvaClienteDaDoc()">${ic("check")} Salva in rubrica</button></div>`)}
    <label style="font-size:13px;color:var(--txt2);display:flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" ${d.destDiv?"checked":""} onchange="_dcSet('destDiv',this.checked,true)"> Luogo di destinazione diverso dalla sede</label>
    ${d.destDiv?`<textarea class="form-input" rows="2" placeholder="Destinazione merce: nome, indirizzo, CAP, comune" oninput="_dcSet('dest',this.value)">${h(d.dest)}</textarea>`:""}

    ${_dcLbl("Righe")}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;padding:10px;border:1px dashed var(--border);border-radius:8px">
      <div style="flex:1 1 180px"><label class="form-label">Cerca</label><input class="form-input" value="${h(docUi.pickQ)}" placeholder="produttore, vino, annata, SKU…" oninput="_dcPickFilter(this.value)"></div>
      <div style="flex:3 1 320px"><label class="form-label">Referenza</label><select id="dc-pick" class="form-select">${_dcPickOpts()}</select></div>
      <div style="width:76px"><label class="form-label">Q.tà</label><input id="dc-pick-qty" class="form-input" inputmode="decimal" value="1"></div>
      ${!ddt||d.prezziDdt?`<div><label class="form-label">Prezzo da</label><select class="form-select" onchange="docUi.listino=this.value;render()">
        <option value="acq" ${docUi.listino==="acq"?"selected":""}>Costo d'acquisto</option><option value="carta" ${docUi.listino==="carta"?"selected":""}>Prezzo carta (IVA scorporata)</option><option value="man" ${docUi.listino==="man"?"selected":""}>Manuale</option></select></div>
      ${docUi.listino==="acq"?`<div style="width:86px"><label class="form-label">Ricarico %</label><input class="form-input" inputmode="decimal" value="${h(docUi.ricarico)}" oninput="docUi.ricarico=this.value"></div>`:""}`:""}
      <button class="btn-primary" onclick="dcAggiungiRef()">${ic("plus")} Aggiungi</button>
      <button class="btn-outline btn-sm" onclick="dcRigaLibera()">Riga libera</button>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Descrizione</th><th>Q.tà</th><th>U.M.</th>${!ddt||d.prezziDdt?`<th>Prezzo unit. (IVA escl.)</th><th>Sc. %</th><th>IVA</th><th class="r">Importo</th>`:""}<th></th></tr></thead>
      <tbody>${righe||`<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--txt4)">Seleziona le referenze dal menù qui sopra</td></tr>`}</tbody></table></div>

    ${ddt?`${_dcLbl("Trasporto")}
      ${_dcGrid(`${_dcSel("Causale trasporto","causTr",d.causTr,_dcArr(DC_CAUS))}${_dcSel("Trasporto a cura del","cura",d.cura,_dcArr(DC_CURA),true)}
        ${d.cura==="Vettore"?_dcInp("Vettore (ragione sociale, P.IVA)","vettore",d.vettore):""}
        <div><label class="form-label">Data inizio trasporto</label><input type="date" class="form-input" value="${h(d.dataTr)}" onchange="_dcSet('dataTr',this.value)"></div>
        <div><label class="form-label">Ora</label><input type="time" class="form-input" value="${h(d.oraTr)}" onchange="_dcSet('oraTr',this.value)"></div>`)}
      ${_dcGrid(`${_dcInp("N. colli","colli",d.colli,'inputmode="numeric"')}${_dcInp("Peso (kg)","peso",d.peso,'inputmode="decimal"')}
        ${_dcSel("Aspetto beni","aspetto",d.aspetto,_dcArr(DC_ASP))}${_dcSel("Porto","porto",d.porto,{Franco:"Franco",Assegnato:"Assegnato"})}
        <div style="display:flex;align-items:flex-end"><label style="font-size:13px;color:var(--txt2);display:flex;gap:6px;align-items:center"><input type="checkbox" ${d.prezziDdt?"checked":""} onchange="_dcSet('prezziDdt',this.checked,true)"> DDT valorizzato (con prezzi)</label></div>`)}`
    :`${_dcLbl("IVA e pagamento")}
      ${_dcGrid(`${_dcSel("Esigibilità IVA","esig",d.esig,{I:"Immediata",D:"Differita",S:"Scissione pagamenti (split)"},true)}
        ${_dcSel("Bollo 2 €","bollo",d.bollo,{auto:"Automatico (>77,47 € esenti)",si:"Sì",no:"No"},true)}
        <div style="display:flex;align-items:flex-end"><label style="font-size:13px;color:var(--txt2);display:flex;gap:6px;align-items:center"><input type="checkbox" ${d.bolloAddeb?"checked":""} onchange="_dcSet('bolloAddeb',this.checked,true)"> Addebita bollo al cliente</label></div>`)}
      ${_dcGrid(`${_dcSel("Modalità","pagMod",d.pagMod,DC_PAG,true)}${_dcSel("Termini","pagTerm",d.pagTerm,DC_TERM,true)}
        ${d.pagTerm==="data"?`<div><label class="form-label">Scadenza</label><input type="date" class="form-input" value="${h(d.pagScad)}" onchange="_dcSet('pagScad',this.value)"></div>`:""}
        ${d.pagMod==="MP05"||d.pagMod==="MP19"?_dcInp("IBAN","iban",d.iban,'style="text-transform:uppercase"')+_dcInp("Banca","banca",d.banca):""}`)}`}
    ${_dcLbl("Causale e note")}
    ${_dcGrid(`<div><label class="form-label">Causale${ddt?"":" (stampata e nell'XML)"}</label><textarea class="form-input" rows="2" oninput="_dcSet('causale',this.value)">${h(d.causale)}</textarea></div>
      <div><label class="form-label">Note (solo stampa)</label><textarea class="form-input" rows="2" oninput="_dcSet('note',this.value)">${h(d.note)}</textarea></div>`,260)}
    <div id="dc-tot" style="max-width:420px;margin-left:auto;margin-bottom:14px">${_dcTotHtml(calc)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
      <button class="btn-outline" onclick="dcAnnulla()">Annulla</button>
      <button class="btn-outline" onclick="dcSalva(true)">${ic("print")} Salva e stampa</button>
      <button class="btn-primary" onclick="dcSalva(false)">${ic("check")} Salva</button>
    </div></div>`;
}

function _dcRenderClienti(){
  const e=docUi.cliEdit;
  const form = e ? `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--amber)">
    <div class="section-label"><span>${ic("edit")} ${e._nuovo?"Nuovo cliente":"Modifica cliente"}</span></div>
    ${_dcGrid(["rs:Ragione sociale","nome:Nome (privato)","cognome:Cognome","piva:P.IVA","cf:Codice fiscale","sdi:Codice SDI","pec:PEC","ind:Indirizzo","cap:CAP","citta:Comune","prov:Prov.","naz:Nazione","email:Email","tel:Telefono"]
      .map(s=>{const [k,l]=s.split(":"); return `<div><label class="form-label">${l}</label><input class="form-input" value="${h(e[k]??"")}" oninput="docUi.cliEdit['${k}']=this.value"></div>`;}).join(""))}
    ${_dcGrid(`<div><label class="form-label">Destinazione merce abituale (se diversa)</label><textarea class="form-input" rows="2" oninput="docUi.cliEdit.dest=this.value">${h(e.dest||"")}</textarea></div>
      <div><label class="form-label">Pagamento abituale</label><select class="form-select" onchange="docUi.cliEdit.pagMod=this.value">${Object.entries(DC_PAG).map(([k,v])=>`<option value="${k}" ${e.pagMod===k?"selected":""}>${v}</option>`).join("")}</select>
        <select class="form-select" style="margin-top:6px" onchange="docUi.cliEdit.pagTerm=this.value">${Object.entries(DC_TERM).filter(([k])=>k!=="data").map(([k,v])=>`<option value="${k}" ${e.pagTerm===k?"selected":""}>${v}</option>`).join("")}</select></div>`,260)}
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-outline" onclick="docUi.cliEdit=null;render()">Annulla</button>
      <button class="btn-primary" onclick="dcCliSalva()">${ic("check")} Salva</button></div></div>`
    : `<div style="margin-bottom:16px"><button class="btn-primary" onclick="docUi.cliEdit={id:uid(),t:'cli',naz:'IT',pagMod:'MP05',pagTerm:'30df',_nuovo:true};render()">+ Nuovo cliente</button></div>`;
  const cli=_dcCli();
  return form+`<div class="card" style="padding:0"><div class="tbl-wrap"><table>
    <thead><tr><th>Cliente</th><th>P.IVA / CF</th><th>SDI / PEC</th><th>Sede</th><th class="r">Documenti</th><th></th></tr></thead>
    <tbody>${cli.length?cli.map(c=>{const n=_dcDocs().filter(d=>d.cli?._id===c.id||(c.piva&&d.cli?.piva===c.piva)).length;
      return `<tr><td>${h(_dcCliNome(c))}</td><td style="color:var(--txt3)">${h(c.piva||c.cf||"—")}</td><td style="color:var(--txt3)">${h(c.sdi||c.pec||"—")}</td>
      <td style="color:var(--txt3);font-size:.8rem">${h([c.ind,c.cap,c.citta,c.prov?`(${c.prov})`:""].filter(Boolean).join(" "))}</td><td class="r">${n}</td>
      <td style="white-space:nowrap"><button class="btn-outline btn-sm" onclick="docUi.cliEdit=JSON.parse(JSON.stringify(docs.find(x=>x.id==='${c.id}')));render()">${ic("edit")}</button>
      <button class="btn-outline btn-sm" onclick="dcCliElimina('${c.id}')">${ic("trash")}</button></td></tr>`;}).join("")
      :`<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--txt4)">Nessun cliente: si aggiungono qui o direttamente dal documento</td></tr>`}</tbody></table></div></div>`;
}
function dcCliSalva(){ const e=docUi.cliEdit; if(!_dcCliNome(e)){ notify("Ragione sociale o nome obbligatori","err"); return; }
  const { _nuovo, ...c } = e; _dcPut(c); docUi.cliEdit=null; _docsSave(); render(); }
function dcCliElimina(id){ if(!confirm("Eliminare il cliente dalla rubrica? I documenti già emessi restano invariati.")) return; docs=docs.filter(x=>x.id!==id); _docsSave(); render(); }

function _dcRenderImpostazioni(){
  const c=_dcCfg(), ced=_dcCedente(), set=(k,v)=>`docs.find(x=>x.id==='cfg')?docs.find(x=>x.id==='cfg')['${k}']=${v}:docs.push({id:'cfg',['${k}']:${v}})`;
  const inp=(lbl,k,val,ex="")=>`<div><label class="form-label">${lbl}</label><input class="form-input" value="${h(val??"")}" ${ex} onchange="${set(k,"this.value")};_docsSave()"></div>`;
  const miss=["rs","piva","ind","cap","citta","prov"].filter(k=>!ced[k]);
  return `<div class="card" style="margin-bottom:16px">
    <div class="section-label"><span>${ic("gear")} Emittente (da Impostazioni › Dati fatturazione)</span></div>
    <div style="font-size:13px;color:var(--txt2);line-height:1.6">${h(ced.rs)||"<em>—</em>"} · P.IVA ${h(ced.piva||"—")} · CF ${h(ced.cf||"—")}<br>
      ${h([ced.ind,ced.cap,ced.citta,ced.prov?`(${ced.prov})`:""].filter(Boolean).join(" ")||"sede non compilata")} · SDI ${h(ced.sdi||"—")} · PEC ${h(ced.pec||"—")}</div>
    ${miss.length?`<div style="margin-top:8px;color:var(--orange);font-size:13px">${ic("alert")} Mancano: ${miss.join(", ")} — compilali in Impostazioni, servono per l'XML.</div>`:""}
  </div>
  <div class="card"><div class="section-label"><span>${ic("receipt")} Impostazioni documenti</span></div>
    ${_dcGrid(`${inp("Sezionale numerazione","sez",_dcSez(),'maxlength="6" style="text-transform:uppercase"')}
      <div><label class="form-label">IVA predefinita</label><select class="form-select" onchange="${set("ivaDef","parseFloat(this.value)")};_docsSave()">${[22,10,5,4,0].map(a=>`<option ${_dcNum(c.ivaDef??22)===a?"selected":""}>${a}</option>`).join("")}</select></div>
      <div><label class="form-label">Regime fiscale</label><select class="form-select" onchange="${set("regime","this.value")};_docsSave()">${Object.entries(DC_REGIMI).map(([k,v])=>`<option value="${k}" ${(c.regime||"RF01")===k?"selected":""}>${k} · ${v}</option>`).join("")}</select></div>
      <div><label class="form-label">Pagamento predefinito</label><select class="form-select" onchange="${set("pagMod","this.value")};_docsSave()">${Object.entries(DC_PAG).map(([k,v])=>`<option value="${k}" ${(c.pagMod||"MP05")===k?"selected":""}>${v}</option>`).join("")}</select></div>
      <div><label class="form-label">Termini predefiniti</label><select class="form-select" onchange="${set("pagTerm","this.value")};_docsSave()">${Object.entries(DC_TERM).filter(([k])=>k!=="data").map(([k,v])=>`<option value="${k}" ${(c.pagTerm||"30df")===k?"selected":""}>${v}</option>`).join("")}</select></div>`)}
    ${_dcGrid(`${inp("IBAN","iban",c.iban,'style="text-transform:uppercase"')}${inp("Banca","banca",c.banca)}`,260)}
    ${_dcLbl("Iscrizione REA (facoltativa nell'XML)")}
    ${_dcGrid(`${inp("Ufficio (prov.)","reaUff",c.reaUff,'maxlength="2"')}${inp("Numero REA","reaNum",c.reaNum)}${inp("Capitale sociale €","reaCap",c.reaCap,'inputmode="decimal"')}
      <div><label class="form-label">Soci</label><select class="form-select" onchange="${set("reaSoci","this.value")};_docsSave()"><option value="">—</option><option value="SU" ${c.reaSoci==="SU"?"selected":""}>Socio unico</option><option value="SM" ${c.reaSoci==="SM"?"selected":""}>Più soci</option></select></div>`,140)}
    <div><label class="form-label">Note predefinite in stampa</label><textarea class="form-input" rows="2" onchange="${set("note","this.value")};_docsSave()">${h(c.note||"")}</textarea></div>
    <div style="font-size:12px;color:var(--txt4);margin-top:10px">Il sezionale distingue la numerazione di questo locale da quella degli altri con la stessa P.IVA (es. 12/${h(_dcSez()||"LG")}).</div>
  </div>`;
}

function _dcRenderEmessi(){
  const anno=docUi.anno, all=_dcDocs(), inAnno=all.filter(d=>anno==="tutti"||String(d.anno)===anno);
  const fatt=inAnno.filter(d=>d.tipo!=="ddt"), segno=d=>d.tipo==="nc"?-1:1;
  const tot=fatt.reduce((s,d)=>{const c=_dcCalc(d); s.imp+=segno(d)*c.imp; s.iva+=segno(d)*c.iva; s.tot+=segno(d)*c.totale; return s;},{imp:0,iva:0,tot:0});
  const daInc=all.filter(d=>d.tipo!=="ddt"&&d.tipo!=="nc"&&!d.pagata).reduce((s,d)=>s+_dcCalc(d).netto,0);
  const scad=all.filter(d=>d.tipo!=="ddt"&&d.tipo!=="nc"&&!d.pagata&&(d.pagScadCalc||_dcScad(d))<today()).reduce((s,d)=>s+_dcCalc(d).netto,0);
  const ddtAperti=all.filter(d=>d.tipo==="ddt"&&!d.fattId&&d.causTr==="Vendita");
  const kpi=(l,v,col,sub)=>`<div class="card" style="padding:14px"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--txt3);margin-bottom:6px">${l}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:1.4rem;color:${col}">${v}</div><div style="font-size:12px;color:var(--txt4);margin-top:4px">${sub}</div></div>`;
  let html=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px">
    ${kpi("Fatturato "+(anno==="tutti"?"totale":anno),fmt(tot.tot),"var(--txt)","imponibile "+fmt(tot.imp))}
    ${kpi("IVA a debito",fmt(tot.iva),"var(--txt2)","al netto delle note di credito")}
    ${kpi("Da incassare",fmt(daInc),daInc>0?"var(--amber)":"var(--txt3)","fatture non segnate incassate")}
    ${kpi("Scaduto",fmt(scad),scad>0?"var(--red)":"var(--txt3)","oltre la scadenza")}
    ${kpi("DDT da fatturare",ddtAperti.length,ddtAperti.length?"var(--orange)":"var(--txt3)","causale vendita")}</div>`;
  html += dcDraft ? _dcRenderForm() : `<div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn-primary" onclick="dcNuovo('fattura')">+ Nuova fattura</button>
    <button class="btn-primary" onclick="dcNuovo('ddt')">+ Nuovo DDT</button>
    <button class="btn-outline btn-sm" onclick="dcNuovo('nc')">+ Nota di credito</button>
    ${docUi.sel.size?`<button class="btn-outline btn-sm" style="border-color:var(--amber);color:var(--amber)" onclick="dcFatturaDaDdt()">${ic("receipt")} Fattura differita da ${docUi.sel.size} DDT</button>`:""}
    <button class="btn-outline btn-sm" onclick="dcExportCSV()">${ic("download")} CSV per commercialista</button></div>`;
  const anni=[...new Set(all.map(d=>String(d.anno)).concat(String(new Date().getFullYear())))].sort().reverse();
  html+=`<div class="card" style="margin-bottom:16px">${_dcGrid(`
    <div><label class="form-label">Tipo</label><select class="form-select" onchange="docUi.tipo=this.value;render()">${Object.entries({tutti:"Tutti",fatture:"Fatture e note",ddt:"DDT",ddtAperti:"DDT da fatturare",daIncassare:"Da incassare"}).map(([k,v])=>`<option value="${k}" ${docUi.tipo===k?"selected":""}>${v}</option>`).join("")}</select></div>
    <div><label class="form-label">Anno</label><select class="form-select" onchange="docUi.anno=this.value;render()"><option value="tutti">Tutti</option>${anni.map(a=>`<option ${anno===a?"selected":""}>${a}</option>`).join("")}</select></div>
    <div><label class="form-label">Cerca</label><input class="form-input" value="${h(docUi.q)}" placeholder="cliente, numero, referenza…" oninput="docUi.q=this.value" onchange="render()"></div>`)}</div>`;
  const q=docUi.q.toLowerCase();
  const rows=inAnno.filter(d=>{
    if(docUi.tipo==="fatture"&&d.tipo==="ddt") return false;
    if(docUi.tipo==="ddt"&&d.tipo!=="ddt") return false;
    if(docUi.tipo==="ddtAperti"&&!(d.tipo==="ddt"&&!d.fattId)) return false;
    if(docUi.tipo==="daIncassare"&&(d.tipo==="ddt"||d.tipo==="nc"||d.pagata)) return false;
    return !q || [_dcCliNome(d.cli),_dcNumLbl(d),d.causale,...(d.righe||[]).map(r=>r.desc)].join(" ").toLowerCase().includes(q);
  }).sort((a,b)=>String(b.data).localeCompare(String(a.data))||(parseInt(b.num)||0)-(parseInt(a.num)||0));
  html+=`<div class="card" style="padding:0"><div class="tbl-header"><span style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--txt3)">Documenti emessi — ${rows.length}</span></div>
    <div class="tbl-wrap"><table><thead><tr><th></th><th>Tipo</th><th>Numero</th><th>Data</th><th>Cliente</th><th class="r">Totale</th><th>Stato</th><th></th></tr></thead>
    <tbody>${rows.length?rows.map(d=>{
      const c=_dcCalc(d), isD=d.tipo==="ddt", sc=d.pagScadCalc||_dcScad(d);
      const st = isD ? (d.fattId?`<span style="color:var(--green)">Fatturato</span>`:d.causTr==="Vendita"?`<span style="color:var(--orange)">Da fatturare</span>`:`<span style="color:var(--txt3)">${h(d.causTr)}</span>`)
        : d.tipo==="nc" ? `<span style="color:var(--txt3)">Nota di credito</span>`
        : d.pagata ? `<span style="color:var(--green)">Incassata</span>` : `<span style="color:${sc<today()?"var(--red)":"var(--amber)"}">${sc<today()?"Scaduta":"Scade"} ${_fmtDataIT(sc)}</span>`;
      return `<tr><td>${isD&&!d.fattId?`<input type="checkbox" ${docUi.sel.has(d.id)?"checked":""} onchange="dcToggleSel('${d.id}',this.checked)" title="Seleziona per fattura differita">`:""}</td>
        <td style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--txt3)">${DC_TIPI[d.tipo].lbl}</td>
        <td>${h(_dcNumLbl(d))}</td><td style="color:var(--txt3)">${_fmtDataIT(d.data)}</td><td>${h(_dcCliNome(d.cli))}</td>
        <td class="r" style="font-family:'Montserrat',sans-serif">${isD?(d.prezziDdt?fmt(c.totale):fmtN(c.pezzi,0)+" pz"):(d.tipo==="nc"?"−":"")+fmt(c.totale)}</td>
        <td style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">${st}</td>
        <td style="white-space:nowrap">
          <button class="btn-outline btn-sm" onclick="dcStampa('${d.id}')" title="Stampa / PDF">${ic("print")}</button>
          ${!isD?`<button class="btn-outline btn-sm" onclick="dcXml('${d.id}')" title="Scarica XML FatturaPA">XML</button>`:""}
          ${!isD&&d.tipo!=="nc"?`<button class="btn-outline btn-sm" onclick="dcPagata('${d.id}')" title="${d.pagata?"Segna da incassare":"Segna incassata"}">${ic(d.pagata?"x":"check")}</button>
            <button class="btn-outline btn-sm" onclick="dcNotaCredito('${d.id}')" title="Nota di credito">NC</button>`:""}
          <button class="btn-outline btn-sm" onclick="dcModifica('${d.id}')" title="Modifica">${ic("edit")}</button>
          <button class="btn-outline btn-sm" onclick="dcDuplica('${d.id}')" title="Duplica">⧉</button>
          <button class="btn-outline btn-sm" onclick="dcElimina('${d.id}')" title="Elimina">${ic("trash")}</button></td></tr>`;}).join("")
      :`<tr><td colspan="8" style="text-align:center;padding:28px;color:var(--txt4)">Nessun documento</td></tr>`}</tbody></table></div></div>`;
  return html;
}

// ─── Aggancio alla sezione Amministrazione (nessuna modifica a manager.js) ──
(function(){
  if(typeof renderAmministrazione!=="function") return;
  const _orig=renderAmministrazione;
  renderAmministrazione=function(){
    if(!_docsLoaded && !_docsLoading) _loadDocs().then(()=>{ if(typeof section!=="undefined"&&section==="amministrazione") render(); });
    const tabs=[["fornitori","Fatture fornitori"],["emessi","Fatture e DDT emessi"],["clienti","Clienti"],["impost","Impostazioni documenti"]];
    const bar=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">${tabs.map(([k,l])=>`<button class="${docUi.tab===k?"btn-primary":"btn-outline"} btn-sm" onclick="docUi.tab='${k}';render()">${l}</button>`).join("")}</div>`;
    const warn = docUi.tab!=="fornitori" && _docsLoaded && !_docsTableOk ? `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--orange)"><div style="font-size:13px;color:var(--txt2)">${ic("alert")} Tabella <code>cm_documenti</code> non raggiungibile: i documenti sono salvati <strong>solo su questo computer</strong> finché non viene creata.</div></div>` : "";
    if(docUi.tab==="fornitori") return bar+_orig();
    if(!_docsLoaded) return bar+`<div class="card" style="color:var(--txt3)">Caricamento documenti…</div>`;
    return bar+warn+(docUi.tab==="emessi"?_dcRenderEmessi():docUi.tab==="clienti"?_dcRenderClienti():_dcRenderImpostazioni());
  };
})();

// ─── Stampa / PDF ────────────────────────────────────────────────────────────
function dcStampa(id){
  const d=docs.find(x=>x.id===id); if(!d) return;
  const ced=_dcCedente(), cfg=_dcCfg(), c=_dcCalc(d), cli=d.cli||{}, ddt=d.tipo==="ddt", prezzi=!ddt||d.prezziDdt;
  const e=s=>h(s??""), eu=n=>_dcIt(n);
  const titolo = ddt ? "Documento di trasporto" : d.tipo==="nc" ? "Nota di credito" : d.tipo==="diff" ? "Fattura differita" : "Fattura";
  const addr=(o)=>[o.ind,[o.cap,o.citta,o.prov?`(${o.prov})`:""].filter(Boolean).join(" "),o.naz&&o.naz!=="IT"?o.naz:""].filter(Boolean).map(e).join("<br>");
  const rea=[cfg.reaUff&&cfg.reaNum?`REA ${e(cfg.reaUff)}-${e(cfg.reaNum)}`:"",cfg.reaCap?`Cap. soc. € ${eu(_dcNum(cfg.reaCap))}`:"",cfg.reaSoci==="SU"?"Socio unico":""].filter(Boolean).join(" · ");
  const righe=c.righe.map(r=>`<tr><td>${e(r.cod)}</td><td>${e(r.desc)}${r.ddt&&d.tipo==="diff"?`<div class="s">DDT ${e(r.ddt)}</div>`:""}</td><td class="r">${fmtN(_dcNum(r.qty),_dcNum(r.qty)%1?2:0)}</td><td>${e(r.um)}</td>
    ${prezzi?`<td class="r">${eu(_dcNum(r.prezzo))}</td><td class="r">${_dcNum(r.sconto)?fmtN(_dcNum(r.sconto),2)+"%":""}</td><td class="r">${_dcNum(r.iva)?_dcNum(r.iva)+"%":e(r.natura)}</td><td class="r">${eu(_dcRigaTot(r))}</td>`:""}</tr>`).join("");
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>${titolo} ${e(_dcNumLbl(d))}</title><style>
    @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:10.5pt/1.4 Helvetica,Arial,sans-serif;color:#111;margin:0}
    .hd{display:flex;justify-content:space-between;gap:20px;margin-bottom:18px}.ced b{font-size:13pt}.s{font-size:8.5pt;color:#555}
    .box{border:1px solid #999;padding:8px 10px;border-radius:3px}.lbl{font-size:7.5pt;text-transform:uppercase;letter-spacing:.08em;color:#666;margin-bottom:3px}
    h1{font-size:15pt;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;margin-bottom:12px}th{background:#eee;font-size:8pt;text-transform:uppercase;text-align:left;padding:5px 6px;border-bottom:1px solid #999}
    td{padding:5px 6px;border-bottom:1px solid #ddd;vertical-align:top}.r{text-align:right}.tot td{border:0;padding:3px 6px}.big{font-size:13pt;font-weight:bold}
    .g3{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.firme{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:30px}
    .firme div{border-top:1px solid #333;padding-top:4px;font-size:8.5pt;text-align:center;margin-top:28px}</style></head><body>
    <div class="hd"><div class="ced"><b>${e(ced.rs)}</b><br>${addr(ced)}<br>P.IVA ${e(ced.piva)}${ced.cf&&ced.cf!==ced.piva?" · C.F. "+e(ced.cf):""}<br>
      <span class="s">${[ced.pec?"PEC "+e(ced.pec):"",ced.email,ced.tel?"Tel. "+e(ced.tel):""].filter(Boolean).join(" · ")}${rea?"<br>"+rea:""}</span></div>
      <div style="text-align:right"><h1>${titolo}</h1>N. <b>${e(_dcNumLbl(d))}</b> del <b>${_fmtDataIT(d.data)}</b>${d.td?`<div class="s">Tipo documento ${d.td}</div>`:""}
      ${d.fattRif?`<div class="s">Rif. fattura n. ${e(d.fattRif.num)} del ${_fmtDataIT(d.fattRif.data)}</div>`:""}${ddt?`<div class="s">D.P.R. 472/1996</div>`:""}</div></div>
    <div class="grid"><div class="box"><div class="lbl">${ddt?"Destinatario":"Cliente"}</div><b>${e(_dcCliNome(cli))}</b><br>${addr(cli)}
      ${cli.piva?`<br>P.IVA ${e(cli.piva)}`:""}${cli.cf&&cli.cf!==cli.piva?`<br>C.F. ${e(cli.cf)}`:""}${!ddt&&(cli.sdi||cli.pec)?`<br><span class="s">${cli.sdi?"SDI "+e(cli.sdi):""}${cli.pec?" PEC "+e(cli.pec):""}</span>`:""}</div>
      <div class="box"><div class="lbl">Luogo di destinazione</div>${d.destDiv&&d.dest?e(d.dest).replace(/\n/g,"<br>"):ddt||!d.destDiv?"Come sede del destinatario":""}</div></div>
    ${ddt?`<div class="g3"><div class="box"><div class="lbl">Causale trasporto</div>${e(d.causTr)}</div><div class="box"><div class="lbl">Trasporto a cura</div>${e(d.cura)}${d.cura==="Vettore"&&d.vettore?"<br>"+e(d.vettore):""}</div>
      <div class="box"><div class="lbl">Inizio trasporto</div>${_fmtDataIT(d.dataTr)} ${e(d.oraTr)}</div><div class="box"><div class="lbl">Porto</div>${e(d.porto)}</div>
      <div class="box"><div class="lbl">Aspetto beni</div>${e(d.aspetto)}</div><div class="box"><div class="lbl">N. colli</div>${e(d.colli)}</div><div class="box"><div class="lbl">Peso kg</div>${e(d.peso)}</div><div class="box"><div class="lbl">Pezzi</div>${fmtN(c.pezzi,0)}</div></div>`:""}
    <table><thead><tr><th>Cod.</th><th>Descrizione</th><th class="r">Q.tà</th><th>U.M.</th>${prezzi?`<th class="r">Prezzo</th><th class="r">Sc.</th><th class="r">IVA</th><th class="r">Importo</th>`:""}</tr></thead><tbody>${righe}</tbody></table>
    ${prezzi?`<div class="grid"><div>${!ddt?`<div class="box" style="margin-bottom:8px"><div class="lbl">Pagamento</div>${e(DC_PAG[d.pagMod]||"")} · ${e(DC_TERM[d.pagTerm]||"")} · scadenza <b>${_fmtDataIT(_dcScad(d))}</b>
      ${d.iban&&(d.pagMod==="MP05"||d.pagMod==="MP19")?`<br>IBAN <b>${e(d.iban)}</b>${d.banca?" · "+e(d.banca):""}`:""}</div>`:""}
      ${d.causale?`<div class="box" style="margin-bottom:8px"><div class="lbl">Causale</div>${e(d.causale)}</div>`:""}
      ${c.riep.filter(x=>x.nat).map(x=>`<div class="s">${x.nat}: ${e(x.rif)}</div>`).join("")}
      ${d.esig==="S"?`<div class="s">Scissione dei pagamenti art. 17-ter DPR 633/72</div>`:""}${c.bollo?`<div class="s">Imposta di bollo assolta in modo virtuale ai sensi del DM 17/06/2014</div>`:""}</div>
      <table class="tot">${c.riep.map(x=>`<tr><td>Imponibile ${x.aliq?x.aliq+"%":x.nat}</td><td class="r">${eu(x.imp)}</td><td>IVA</td><td class="r">${eu(x.iva)}</td></tr>`).join("")}
      <tr><td colspan="3"><b>Totale imponibile</b></td><td class="r">${eu(c.imp)}</td></tr><tr><td colspan="3"><b>Totale IVA</b></td><td class="r">${eu(c.iva)}</td></tr>
      <tr><td colspan="3" class="big">Totale ${d.tipo==="nc"?"nota di credito":"documento"} €</td><td class="r big">${eu(c.totale)}</td></tr>
      ${d.esig==="S"?`<tr><td colspan="3">Netto a pagare (split payment)</td><td class="r"><b>${eu(c.netto)}</b></td></tr>`:""}</table></div>`
      : d.causale?`<div class="box"><div class="lbl">Annotazioni</div>${e(d.causale)}</div>`:""}
    ${d.note?`<div class="s" style="margin-top:8px">${e(d.note).replace(/\n/g,"<br>")}</div>`:""}
    ${ddt?`<div class="firme"><div>Firma conducente</div><div>Firma vettore</div><div>Firma destinatario</div></div>`
      :`<div class="s" style="margin-top:16px">Copia di cortesia priva di valore fiscale: l'originale è il file XML trasmesso tramite Sistema di Interscambio.</div>`}
    </body></html>`;
  _printHtml(html);
}

// ─── XML FatturaPA (FPR12, privati) ──────────────────────────────────────────
const _dcX = s => String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[ch])).normalize("NFC");
const _dcPU = v => { const n=_dcNum(v); return Math.abs(n*100-Math.round(n*100))<1e-9 ? n.toFixed(2) : String(+n.toFixed(8)); };
const _dcTag = (t,v) => (v===undefined||v===null||v==="") ? "" : `<${t}>${v}</${t}>`;
function dcXml(id){
  const d=docs.find(x=>x.id===id); if(!d||d.tipo==="ddt") return;
  const ced=_dcCedente(), cfg=_dcCfg(), cli=d.cli||{}, c=_dcCalc(d), x=_dcX, n2=v=>_dcR2(v).toFixed(2);
  const err=[]; if(!ced.piva) err.push("P.IVA emittente"); if(!ced.ind||!ced.cap||!ced.citta) err.push("sede emittente (Impostazioni)");
  if(!cli.ind||!cli.citta) err.push("indirizzo cliente"); if((cli.naz||"IT")==="IT"&&!/^\d{5}$/.test(cli.cap||"")) err.push("CAP cliente (5 cifre)");
  if(!cli.piva&&!cli.cf) err.push("P.IVA o CF cliente");
  if(err.length){ alert("Per l'XML mancano:\n• "+err.join("\n• ")); return; }
  const naz=(cli.naz||"IT").toUpperCase(), estero=naz!=="IT";
  const sdi = estero ? "XXXXXXX" : (String(cli.sdi||"").trim().toUpperCase() || "0000000");
  d.invii=(d.invii||0)+1; _docsSave();
  const prog=(String(d.sez||"").replace(/[^A-Z0-9]/gi,"").slice(0,2)+String(d.anno).slice(2)+(parseInt(d.num)||0).toString(36).padStart(4,"0")+d.invii.toString(36).padStart(2,"0")).toUpperCase().slice(0,10);
  const pivaC=String(cli.piva||"").replace(/\s/g,"").toUpperCase(), pivaPaese=/^[A-Z]{2}/.test(pivaC)?pivaC.slice(0,2):naz, pivaCod=/^[A-Z]{2}/.test(pivaC)?pivaC.slice(2):pivaC;
  const sede=o=>`<Sede>${_dcTag("Indirizzo",x(o.ind))}${_dcTag("CAP",o.naz&&o.naz!=="IT"?"00000":x(o.cap))}${_dcTag("Comune",x(o.citta))}${o.naz&&o.naz!=="IT"?"":_dcTag("Provincia",x(String(o.prov||"").toUpperCase()))}${_dcTag("Nazione",x(o.naz||"IT"))}</Sede>`;
  const causali=[]; let cs=String(d.causale||"").trim(); while(cs){ causali.push(cs.slice(0,200)); cs=cs.slice(200); }
  const linee=c.righe.map((r,i)=>{ const q=_dcNum(r.qty), aliq=_dcNum(r.iva), sc=_dcNum(r.sconto);
    return `<DettaglioLinee><NumeroLinea>${i+1}</NumeroLinea>${r.cod?`<CodiceArticolo><CodiceTipo>INTERNO</CodiceTipo><CodiceValore>${x(r.cod.slice(0,35))}</CodiceValore></CodiceArticolo>`:""}
<Descrizione>${x(String(r.desc).slice(0,1000))}</Descrizione><Quantita>${q.toFixed(2)}</Quantita>${_dcTag("UnitaMisura",x(String(r.um||"").slice(0,10)))}<PrezzoUnitario>${_dcPU(r.prezzo)}</PrezzoUnitario>
${sc?`<ScontoMaggiorazione><Tipo>SC</Tipo><Percentuale>${sc.toFixed(2)}</Percentuale></ScontoMaggiorazione>`:""}<PrezzoTotale>${n2(_dcRigaTot(r))}</PrezzoTotale><AliquotaIVA>${aliq.toFixed(2)}</AliquotaIVA>${aliq?"":`<Natura>${r.natura||"N2.2"}</Natura>`}</DettaglioLinee>`; }).join("\n");
  const riep=c.riep.map(r=>`<DatiRiepilogo><AliquotaIVA>${r.aliq.toFixed(2)}</AliquotaIVA>${r.nat?`<Natura>${r.nat}</Natura>`:""}<ImponibileImporto>${n2(r.imp)}</ImponibileImporto><Imposta>${n2(r.iva)}</Imposta>${r.aliq?`<EsigibilitaIVA>${d.esig||"I"}</EsigibilitaIVA>`:""}${r.nat?`<RiferimentoNormativo>${x(r.rif.slice(0,100))}</RiferimentoNormativo>`:""}</DatiRiepilogo>`).join("\n");
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2 http://www.fatturapa.gov.it/export/fatturazione/sdi/fatturapa/v1.2/Schema_del_file_xml_FatturaPA_versione_1.2.xsd">
<FatturaElettronicaHeader>
<DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${x(ced.cf||ced.piva)}</IdCodice></IdTrasmittente><ProgressivoInvio>${prog}</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>${sdi}</CodiceDestinatario>${sdi==="0000000"&&cli.pec?`<PECDestinatario>${x(cli.pec)}</PECDestinatario>`:""}</DatiTrasmissione>
<CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${x(ced.piva)}</IdCodice></IdFiscaleIVA>${_dcTag("CodiceFiscale",x(ced.cf))}<Anagrafica><Denominazione>${x(ced.rs.slice(0,80))}</Denominazione></Anagrafica><RegimeFiscale>${cfg.regime||"RF01"}</RegimeFiscale></DatiAnagrafici>
${sede({...ced,naz:"IT"})}${cfg.reaUff&&cfg.reaNum?`<IscrizioneREA><Ufficio>${x(cfg.reaUff.toUpperCase())}</Ufficio><NumeroREA>${x(cfg.reaNum)}</NumeroREA>${cfg.reaCap?`<CapitaleSociale>${_dcNum(cfg.reaCap).toFixed(2)}</CapitaleSociale>`:""}${cfg.reaSoci?`<SocioUnico>${cfg.reaSoci}</SocioUnico>`:""}<StatoLiquidazione>LN</StatoLiquidazione></IscrizioneREA>`:""}</CedentePrestatore>
<CessionarioCommittente><DatiAnagrafici>${pivaCod?`<IdFiscaleIVA><IdPaese>${x(pivaPaese)}</IdPaese><IdCodice>${x(pivaCod)}</IdCodice></IdFiscaleIVA>`:""}${!estero&&cli.cf?`<CodiceFiscale>${x(String(cli.cf).toUpperCase())}</CodiceFiscale>`:""}
<Anagrafica>${cli.rs?`<Denominazione>${x(cli.rs.slice(0,80))}</Denominazione>`:`<Nome>${x(cli.nome)}</Nome><Cognome>${x(cli.cognome)}</Cognome>`}</Anagrafica></DatiAnagrafici>${sede({...cli,naz})}</CessionarioCommittente>
</FatturaElettronicaHeader>
<FatturaElettronicaBody>
<DatiGenerali><DatiGeneraliDocumento><TipoDocumento>${d.td||DC_TIPI[d.tipo].td}</TipoDocumento><Divisa>EUR</Divisa><Data>${d.data}</Data><Numero>${x(_dcNumLbl(d))}</Numero>
${c.bollo?`<DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo>`:""}<ImportoTotaleDocumento>${n2(c.totale)}</ImportoTotaleDocumento>${causali.map(s=>`<Causale>${x(s)}</Causale>`).join("")}</DatiGeneraliDocumento>
${d.fattRif?`<DatiFattureCollegate><IdDocumento>${x(d.fattRif.num)}</IdDocumento><Data>${d.fattRif.data}</Data></DatiFattureCollegate>`:""}
${(d.ddtRif||[]).map(r=>`<DatiDDT><NumeroDDT>${x(r.num)}</NumeroDDT><DataDDT>${r.data}</DataDDT></DatiDDT>`).join("")}
</DatiGenerali>
<DatiBeniServizi>
${linee}
${riep}
</DatiBeniServizi>
${d.tipo!=="nc"?`<DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>${d.pagMod||"MP05"}</ModalitaPagamento><DataScadenzaPagamento>${_dcScad(d)}</DataScadenzaPagamento><ImportoPagamento>${n2(c.netto)}</ImportoPagamento>${(d.pagMod==="MP05"||d.pagMod==="MP19")&&d.banca?`<IstitutoFinanziario>${x(d.banca.slice(0,80))}</IstitutoFinanziario>`:""}${(d.pagMod==="MP05"||d.pagMod==="MP19")&&d.iban?`<IBAN>${x(d.iban.replace(/\s/g,"").toUpperCase())}</IBAN>`:""}</DettaglioPagamento></DatiPagamento>`:""}
</FatturaElettronicaBody>
</p:FatturaElettronica>`;
  const fn=`IT${ced.piva}_${(String(d.sez||'X').slice(0,1)+String(d.anno).slice(-1)+(parseInt(d.num)||0).toString(36).padStart(2,'0')+(d.invii%36).toString(36)).toUpperCase()}.xml`;
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([xml],{type:"application/xml"})); a.download=fn;
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },500);
  notify(`XML ${fn} scaricato: caricalo su Fatture e Corrispettivi o nel software del commercialista`);
}

// ─── CSV per il commercialista ───────────────────────────────────────────────
function dcExportCSV(){
  const rows=[["Tipo","TD","Numero","Data","Cliente","P.IVA","CF","Aliquota/Natura","Imponibile","IVA","Totale documento","Esigibilita","Pagamento","Scadenza","Incassata","DDT collegati"]];
  _dcDocs().filter(d=>docUi.anno==="tutti"||String(d.anno)===docUi.anno).sort((a,b)=>String(a.data).localeCompare(String(b.data))).forEach(d=>{
    const c=_dcCalc(d), s=d.tipo==="nc"?-1:1;
    (d.tipo==="ddt"?[{aliq:"",nat:"",imp:c.imp,iva:c.iva}]:c.riep).forEach(r=>rows.push([DC_TIPI[d.tipo].lbl,d.td||"",_dcNumLbl(d),d.data,_dcCliNome(d.cli),d.cli?.piva||"",d.cli?.cf||"",
      r.aliq?r.aliq+"%":r.nat,(s*r.imp).toFixed(2).replace(".",","),(s*r.iva).toFixed(2).replace(".",","),(s*c.totale).toFixed(2).replace(".",","),d.esig||"",
      d.tipo==="ddt"?"":DC_PAG[d.pagMod]||"",d.tipo==="ddt"?"":_dcScad(d),d.pagata?"SI":"NO",(d.ddtRif||[]).map(x=>x.num).join(" ")]));
  });
  const csv="﻿"+rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(";")).join("\n");
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  a.download=`documenti-emessi-${(typeof CONFIG!=="undefined"&&CONFIG.lsPrefix||"").replace(/_$/,"")}-${docUi.anno}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },500);
}
