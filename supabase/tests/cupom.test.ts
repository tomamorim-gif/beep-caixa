// Testes da entrada por cupom fiscal (NFC-e). Rodar: node --experimental-strip-types --test supabase/tests/cupom.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CupomInvalido, dvOk, erroSefaz, lerCupom } from "../functions/_shared/cupom.ts";
// @ts-ignore módulo do painel (JS puro)
import { fatorEmbalagem, gtinOk, numBr, parecido, sugestoes, termos } from "../../gestao/cupom.js";

function chave(tpEmis = "1", uf = "23", mod = "65") {
  const base = uf + "2611" + "06057223000171" + mod + "001" + "000123456" + tpEmis + "12345678";
  for (let d = 0; d < 10; d++) if (dvOk(base + d)) return base + d;
  throw new Error("sem dv");
}
const HASH = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678";
const CE = "http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html?p=";

test("lerCupom: QR v2 online vira o pedido do site da SEFAZ-CE", () => {
  const ch = chave();
  const c = lerCupom(`${CE}${ch}|2|1|1|${HASH}`);
  assert.equal(c.chave, ch);
  assert.deepEqual(c.payload, { chave_acesso: ch, versao_qrcode: "2", tipo_ambiente: "1", identificador_csc: "1", codigo_hash: HASH });
  assert.match(c.url, /qrcodev2\/$/);
  // QR lido com %7C no lugar de |
  assert.equal(lerCupom(`${CE}${ch}%7C2%7C1%7C1%7C${HASH}`).payload.codigo_hash, HASH);
});

test("lerCupom: contingência, v3 e só a chave", () => {
  const ch9 = chave("9");
  const c = lerCupom(`${CE}${ch9}|2|1|26|58.90|QUJDRA==|1|${HASH}`);
  assert.deepEqual(c.payload, { chave_acesso: ch9, versao_qrcode: "2", tipo_ambiente: "1", dia_data_emissao: "26", valor_total_nfce: "58.90", digVal: "QUJDRA==", identificador_csc: "1", codigo_hash: HASH });
  const v3 = lerCupom(`${CE}${chave()}|3|1`);
  assert.match(v3.url, /qrcodev3\/$/);
  const so = lerCupom(chave().replace(/(\d{4})/g, "$1 "));
  assert.equal(so.soChave, true);
  assert.equal(so.payload.versao_qrcode, "3");
});

test("lerCupom: recusa o que não é cupom do Ceará", () => {
  const ch = chave();
  const ruins = [
    "",
    "https://exemplo.com/?p=" + ch + "|3|1",
    `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${chave("1", "43")}|2|1|1|${HASH}`,
    `${CE}${ch}|2|2|1|${HASH}`, // homologação
    `${CE}${ch.slice(0, 43) + ((+ch[43] + 1) % 10)}|3|1`, // dígito errado
    `${CE}${ch}|2|1|1|curto`,
    chave("1", "23", "55"), // NF-e
    "7891000100103",
  ];
  for (const r of ruins) assert.throws(() => lerCupom(r), CupomInvalido, r);
});

test("erroSefaz: 236 explica o que fazer", () => {
  assert.match(erroSefaz("236 - Regra de neg&oacute;cios da NFC-e", true), /Leia o QR code/);
  assert.match(erroSefaz("236 - Regra de neg&oacute;cios da NFC-e", false), /não encontrou/);
});

test("código de barras, números e embalagem", () => {
  assert.equal(gtinOk("7894900011517"), true);
  assert.equal(gtinOk("7894900011518"), false);
  assert.equal(gtinOk("12345"), false);
  assert.equal(numBr("1.234,56"), 1234.56);
  assert.equal(numBr("0,764"), 0.764);
  assert.equal(fatorEmbalagem("CX", "REFRIG COCA COLA LATA 350ML C/12"), 12);
  assert.equal(fatorEmbalagem("FD", "AGUA MINERAL 6X1,5L"), 6);
  assert.equal(fatorEmbalagem("UN", "AGUA MINERAL C/12"), 1);
  assert.equal(fatorEmbalagem("DZ", "OVOS"), 12);
});

test("termos: abreviações e medidas do cupom", () => {
  assert.deepEqual(termos("REFRIG COCA COLA PET 2LT"), { palavras: ["refrigerante", "coca", "cola", "pet"], medidas: ["2000ml"] });
  assert.deepEqual(termos("Biscoito Recheado 140 g").medidas, ["140g"]);
});

test("sugestoes: acha o produto parecido e respeita o tamanho", () => {
  const P = [
    { id: 1, nome: "Coca-Cola 2L", ativo: true },
    { id: 2, nome: "Coca-Cola Lata 350ml", ativo: true },
    { id: 3, nome: "Guaraná Antarctica 2L", ativo: true },
    { id: 4, nome: "Biscoito Recheado Passatempo Chocolate 130g", ativo: true },
    { id: 5, nome: "Coca-Cola 2L antiga", ativo: false },
  ];
  const s = sugestoes("REFRIG COCA COLA PET 2L", P);
  assert.equal(s[0].p.id, 1);
  assert.ok(!s.some((x: any) => x.p.id === 5));
  assert.equal(sugestoes("BISC RECH PASSATEMPO CHOC 130G", P)[0].p.id, 4);
  assert.equal(sugestoes("DETERGENTE YPE NEUTRO 500ML", P).length, 0);
  assert.ok(parecido("COCA COLA LATA 350ML", "Coca-Cola 2L") < parecido("COCA COLA LATA 350ML", "Coca-Cola Lata 350ml"));
});
