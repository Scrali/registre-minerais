// Tests de la lecture des infobulles de caisse (ocrlogic.js) : texte reconnu par OCR, sans IA.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../ocrlogic.js";
const { parseTooltip, sameRead } = globalThis.OcrLogic;

test("Infobulle complète : contenu de la caisse, jamais son volume ni sa capacité", () => {
  const t = "Cuivre (M)\nVolume: 1000000 µSCU\nCapacité: 1.00SCU\nCuivre (M) 855 0.503 SCU";
  assert.deepEqual(({ ...parseTooltip(t), line: undefined }), { name: "Cuivre", quality: 855, qty: 0.503, unit: "SCU", line: undefined });
  assert.equal(parseTooltip("Cuivre (M)\nVolume: 1000000 µSCU\nCapacité: 1.00SCU"), null, "sans la ligne de contenu : rien n'est inventé");
});

test("Variantes de lecture OCR : séparateurs, virgule, O pour 0, anglais, accents, unités", () => {
  assert.equal(parseTooltip("Cuivre (M) | 652 | 0,115 SCU").qty, 0.115);
  assert.equal(parseTooltip("Cuivre (M) 359 4 SCU").qty, 4);
  assert.equal(parseTooltip("Copper (M) 652 O.115 SCU").qty, 0.115);
  assert.deepEqual([parseTooltip("Étain [M] 410 1.2 SCU").name, parseTooltip("Étain [M] 410 1.2 SCU").quality], ["Étain", 410]);
  assert.equal(parseTooltip("Quantainium (Ore) 712 50 cSCU").qty, 0.5);
  assert.equal(parseTooltip("Fer 874 250000 µSCU").qty, 0.25);
  assert.equal(parseTooltip("Pressurized Ice (M) 300 1.2 SCU").name, "Pressurized Ice");
  assert.equal(parseTooltip("Fer 32s 1 SCU").quality, 325, "s lu à la place d'un 5 en fin de qualité");
  assert.deepEqual([parseTooltip("Sadaryx 258 0 001 SCu").quality, parseTooltip("Sadaryx 258 0 001 SCu").qty], [258, 0.001], "point décimal perdu");
  assert.equal(parseTooltip("Aphorite 686 0.001 SCY").qty, 0.001, "U lu Y");
});

test("Textes qui ne sont pas une infobulle de contenu : ignorés", () => {
  assert.equal(parseTooltip("CAPACITÉ: 60K/196K SCU 30%"), null);
  assert.equal(parseTooltip("TOUT DEPLACER\nPERSONNEL / TOUS"), null);
  assert.equal(parseTooltip("Cuivre (M) 1855 0.5 SCU"), null, "qualité au-delà de 1000");
  assert.equal(parseTooltip("Cuivre (M) 855 0 SCU"), null, "contenu nul");
});

test("Même caisse capturée deux fois de suite : doublon probable", () => {
  const a = { name: "Cuivre", quality: 855, qty: 0.503, at: 1000 };
  assert.equal(sameRead(a, { ...a, at: 3000 }), true);
  assert.equal(sameRead(a, { ...a, at: 9000 }), false, "plusieurs secondes après : peut-être une autre caisse");
  assert.equal(sameRead(a, { ...a, qty: 0.5, at: 1500 }), false);
});
