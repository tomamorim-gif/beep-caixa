// Testes da busca de NF-e de compra pela chave. Rodar: node --experimental-strip-types --test supabase/tests/dfe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { chaveValida, distPorChave, distPorNsu, gunzipB64, infEventoCiencia, lerDist, lerDoc, soapDist } from "../functions/_shared/dfe.ts";

const CHAVE = "23261107196033002141550070094346051503115470";

test("chaveValida: dígito verificador e modelo 55", () => {
  assert.equal(chaveValida(CHAVE), true);
  assert.equal(chaveValida(CHAVE.slice(0, 43) + "1"), false);
  assert.equal(chaveValida("123"), false);
  // modelo 65 (NFC-e) não é nota de compra
  const m65 = CHAVE.slice(0, 20) + "65" + CHAVE.slice(22);
  assert.equal(chaveValida(m65), false);
});

test("distPorChave: pedido no leiaute 1.01", () => {
  const x = distPorChave({ tpAmb: 1, cUF: "23", cnpj: "12.345.678/0001-99", chave: CHAVE });
  assert.match(x, /^<distDFeInt xmlns="http:\/\/www.portalfiscal.inf.br\/nfe" versao="1.01"><tpAmb>1<\/tpAmb><cUFAutor>23<\/cUFAutor><CNPJ>12345678000199<\/CNPJ><consChNFe><chNFe>\d{44}<\/chNFe><\/consChNFe><\/distDFeInt>$/);
  assert.match(soapDist(x), /<nfeDistDFeInteresse xmlns="http:\/\/www.portalfiscal.inf.br\/nfe\/wsdl\/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt/);
});

test("infEventoCiencia: evento 210210 no Ambiente Nacional", () => {
  const { xml, id } = infEventoCiencia({ tpAmb: 1, cnpj: "12345678000199", chave: CHAVE, dh: "2026-11-24T13:00:00-03:00" });
  assert.equal(id, `ID210210${CHAVE}01`);
  assert.match(xml, /<cOrgao>91<\/cOrgao>/);
  assert.match(xml, /<tpEvento>210210<\/tpEvento><nSeqEvento>1<\/nSeqEvento><verEvento>1.00<\/verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao<\/descEvento><\/detEvento>/);
});

test("lerDist + gunzipB64: abre o procNFe compactado", async () => {
  const nota = `<nfeProc><NFe><infNFe Id="NFe${CHAVE}"></infNFe></NFe></nfeProc>`;
  const b64 = gzipSync(Buffer.from(nota)).toString("base64");
  const ret = `<retDistDFeInt versao="1.01"><tpAmb>1</tpAmb><cStat>138</cStat><xMotivo>Documento localizado</xMotivo><loteDistDFeInt><docZip NSU="000000000000123" schema="procNFe_v4.00.xsd">${b64}</docZip></loteDistDFeInt></retDistDFeInt>`;
  const d = lerDist(ret);
  assert.equal(d.cStat, 138);
  assert.equal(d.docs.length, 1);
  assert.equal(d.docs[0].schema, "procNFe_v4.00.xsd");
  assert.equal(await gunzipB64(d.docs[0].b64), nota);
});

test("lerDist: nada encontrado", () => {
  const d = lerDist(`<retDistDFeInt><cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo></retDistDFeInt>`);
  assert.equal(d.cStat, 137);
  assert.equal(d.docs.length, 0);
});

test("distPorNsu: NSU com 15 dígitos", () => {
  assert.match(distPorNsu({ tpAmb: 1, cUF: "23", cnpj: "12345678000199", ultNsu: "123" }), /<distNSU><ultNSU>000000000000123<\/ultNSU><\/distNSU>/);
});

test("lerDoc: resumo, nota completa e cancelamento", () => {
  const r = lerDoc("resNFe_v1.01.xsd", `<resNFe><chNFe>${CHAVE}</chNFe><CNPJ>07196033002141</CNPJ><xNome>FORNECEDOR SA</xNome><IE>1</IE><dhEmi>2026-11-20T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1234.56</vNF><cSitNFe>1</cSitNFe></resNFe>`);
  assert.deepEqual([r.tipo, r.chave, r.emitenteCnpj, r.valor, r.situacao], ["resumo", CHAVE, "07196033002141", 123456, "1"]);
  const n = lerDoc("procNFe_v4.00.xsd", `<nfeProc><NFe><infNFe Id="NFe${CHAVE}" versao="4.00"><ide><dhEmi>2026-11-20T10:00:00-03:00</dhEmi></ide><emit><CNPJ>07196033002141</CNPJ><xNome>FORNECEDOR SA</xNome></emit><dest><CNPJ>11111111000111</CNPJ><xNome>BEEP</xNome></dest><total><ICMSTot><vNF>99.90</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`);
  assert.deepEqual([n.tipo, n.chave, n.emitenteNome, n.valor], ["nota", CHAVE, "FORNECEDOR SA", 9990]);
  const e = lerDoc("resEvento_v1.01.xsd", `<resEvento><chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento></resEvento>`);
  assert.deepEqual([e.tipo, e.tpEvento], ["evento", "110111"]);
});

test("lerDist: ultNSU e maxNSU", () => {
  const d = lerDist(`<retDistDFeInt><cStat>138</cStat><xMotivo>ok</xMotivo><ultNSU>000000000000010</ultNSU><maxNSU>000000000000020</maxNSU></retDistDFeInt>`);
  assert.equal(d.ultNsu, "000000000000010");
  assert.equal(d.maxNsu, "000000000000020");
});
