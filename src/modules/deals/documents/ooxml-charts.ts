/**
 * Native, editable Word charts. The `docx` library has no chart support, so builders drop a marker paragraph
 * ("[[CRECHART:n]]") and `injectDocxCharts` post-processes the package: it adds a DrawingML chart part with cached
 * values plus an embedded workbook (so "Edit Data" works in Word), the relationships and content types, and replaces
 * the marker paragraph with an inline chart. Bars for comparisons; a scatter plot (one labelled series per point,
 * hidden axes) for the schematic location map.
 */
import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { ChartSpec, MapModel } from "./visuals";

export const chartMarker = (n: number) => `[[CRECHART:${n}]]`;
export interface DocxChart { n: number; title: string; kind: "bar" | "map"; spec?: ChartSpec; map?: MapModel; colors: string[]; widthIn: number; heightIn: number }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EMU = 914400;
const col = (i: number) => String.fromCharCode(66 + i); // B, C, ...

function strCache(f: string, vals: string[]) {
  return `<c:strRef><c:f>${f}</c:f><c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef>`;
}
function numCache(f: string, vals: number[], fmt = "General") {
  return `<c:numRef><c:f>${f}</c:f><c:numCache><c:formatCode>${esc(fmt)}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numCache></c:numRef>`;
}
const title = (t: string) => `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"/></a:pPr><a:r><a:rPr lang="en-IN" sz="1100" b="1"/><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/>`;
const tail = `<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;

export function barChartXml(spec: ChartSpec, colors: string[]): string {
  const n = spec.categories.length;
  const sers = spec.series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx>${strCache(`Sheet1!$${col(i)}$1`, [s.name])}</c:tx>`
    + `<c:spPr><a:solidFill><a:srgbClr val="${colors[i % colors.length]}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`
    + `<c:cat>${strCache(`Sheet1!$A$2:$A$${n + 1}`, spec.categories)}</c:cat><c:val>${numCache(`Sheet1!$${col(i)}$2:$${col(i)}$${n + 1}`, s.values, "#,##0")}</c:val></c:ser>`).join("");
  return `${head}<c:chart>${title(spec.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}`
    + `<c:gapWidth val="80"/><c:axId val="51001"/><c:axId val="51002"/></c:barChart>`
    + `<c:catAx><c:axId val="51001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="51002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`
    + `<c:valAx><c:axId val="51002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(spec.unit)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="51001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
    + `</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>${tail}`;
}

/** Schematic map: x,y in 0..1 from buildMapModel (y flipped so north is up), axes fixed and hidden. */
export function mapChartXml(map: MapModel, chartTitle: string, colors: string[]): string {
  const sers = map.points.map((p, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx>${strCache(`Sheet1!$${col(i)}$1`, [p.label])}</c:tx>`
    + `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="${p.kind === "option" ? "circle" : "diamond"}"/><c:size val="${p.kind === "option" ? 9 : 7}"/><c:spPr><a:solidFill><a:srgbClr val="${p.kind === "option" ? colors[0] : colors[1] ?? colors[0]}"/></a:solidFill></c:spPr></c:marker>`
    + `<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="en-IN"/></a:p></c:txPr><c:dLblPos val="r"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="1"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`
    + `<c:xVal>${numCache(`Sheet1!$A$${i + 2}`, [Number(p.x.toFixed(5))])}</c:xVal><c:yVal>${numCache(`Sheet1!$${col(i)}$${i + 2}`, [Number((1 - p.y).toFixed(5))])}</c:yVal><c:smooth val="0"/></c:ser>`).join("");
  const ax = (id: number, cross: number, pos: string) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/><c:max val="1"/><c:min val="0"/></c:scaling><c:delete val="1"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="none"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  return `${head}<c:chart>${title(chartTitle)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}<c:axId val="52001"/><c:axId val="52002"/></c:scatterChart>`
    + `${ax(52001, 52002, "b")}${ax(52002, 52001, "l")}<c:spPr><a:solidFill><a:srgbClr val="F4F6F8"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="BBBBBB"/></a:solidFill></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>${tail}`;
}

/** Embedded workbook with the same numbers, so the chart stays editable in Word. */
async function chartWorkbook(c: DocxChart): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  if (c.kind === "bar" && c.spec) {
    ws.getRow(1).values = ["", ...c.spec.series.map((s) => s.name)];
    c.spec.categories.forEach((cat, r) => { ws.getRow(r + 2).values = [cat, ...c.spec!.series.map((s) => s.values[r])]; });
  } else if (c.map) {
    ws.getRow(1).values = ["x (0–1)", ...c.map.points.map((p) => p.label)];
    c.map.points.forEach((p, i) => { const row = ws.getRow(i + 2); row.getCell(1).value = Number(p.x.toFixed(5)); row.getCell(i + 2).value = Number((1 - p.y).toFixed(5)); });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function injectDocxCharts(docx: Buffer, charts: DocxChart[]): Promise<Buffer> {
  if (!charts.length) return docx;
  const zip = await JSZip.loadAsync(docx);
  let doc = await zip.file("word/document.xml")!.async("string");
  let rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  let types = await zip.file("[Content_Types].xml")!.async("string");
  if (!types.includes('Extension="xlsx"')) types = types.replace("<Types ", "<Types ").replace(/(<Types[^>]*>)/, `$1<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>`);
  for (const c of charts) {
    const marker = chartMarker(c.n);
    const idx = doc.indexOf(marker);
    if (idx < 0) continue;
    const pStart = Math.max(doc.lastIndexOf("<w:p>", idx), doc.lastIndexOf("<w:p ", idx));
    const pEnd = doc.indexOf("</w:p>", idx) + "</w:p>".length;
    const rid = `rIdCreChart${c.n}`;
    const cx = Math.round(c.widthIn * EMU), cy = Math.round(c.heightIn * EMU);
    const drawing = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${7000 + c.n}" name="Chart ${c.n}" descr="${esc(c.title)}"/><wp:cNvGraphicFramePr/>`
      + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">`
      + `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    doc = doc.slice(0, pStart) + drawing + doc.slice(pEnd);
    const xml = c.kind === "bar" ? barChartXml(c.spec!, c.colors) : mapChartXml(c.map!, c.title, c.colors);
    zip.file(`word/charts/chart${c.n}.xml`, xml);
    zip.file(`word/embeddings/cre_chart_data_${c.n}.xlsx`, await chartWorkbook(c));
    zip.file(`word/charts/_rels/chart${c.n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/cre_chart_data_${c.n}.xlsx"/></Relationships>`);
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart${c.n}.xml"/></Relationships>`);
    types = types.replace("</Types>", `<Override PartName="/word/charts/chart${c.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
  }
  if (!/xmlns:wp=/.test(doc.slice(0, 3000))) doc = doc.replace("<w:document ", `<w:document xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" `);
  zip.file("word/document.xml", doc);
  zip.file("word/_rels/document.xml.rels", rels);
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
