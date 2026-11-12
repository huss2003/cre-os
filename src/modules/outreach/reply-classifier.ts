/**
 * Deterministic reply classifier (AI policy "off" path for outreach.response and integrations.triage).
 * Keyword/pattern rules over English, Hindi (Devanagari) and Hinglish (Hindi in Latin script). Pure; no I/O.
 * Precedence: unsubscribe > out_of_office > wrong_person > not_interested > meeting > not_now > info_requested > interested
 * ("let's talk next month" is a meeting ask; an explicit "not now / abhi nahi" still wins over a meeting phrase).
 * The text is untrusted evidence (S7): it is only matched, never followed.
 */
export type ReplyClass = "interested" | "meeting" | "info_requested" | "not_now" | "not_interested" | "out_of_office" | "wrong_person" | "unsubscribe" | "unclear";

export interface ReplyClassification { label: ReplyClass; confidence: "high" | "medium" | "low"; matched: string[] }

const R: [ReplyClass, RegExp[]][] = [
  ["unsubscribe", [
    /\bunsubscribe\b/, /\bremove me\b/, /\bdo not (?:contact|email|message|call)\b/, /\bdon'?t (?:contact|email|message|call) (?:me|us)\b/, /\bstop (?:messag|email|contact|call|spamm)\w*/, /\bopt[\s-]?out\b/,
    /\bmat (?:bhejo|bhejna|karo call|call karo|message karo)\b/, /\bmessage (?:mat|na) (?:bhejo|karo|bhejna)\b/, /\bcall mat karna\b/, /\bdobara (?:contact|message|call) mat\b/, /संपर्क न करें|मैसेज मत भेजो|कॉल मत करो/,
  ]],
  ["out_of_office", [
    /\bout of (?:the )?office\b/, /\bauto[\s-]?reply\b/, /\bautomatic reply\b/, /\bon (?:annual |sick |maternity |paternity )?leave\b/, /\bon vacation\b/, /\baway (?:until|till|from)\b/, /\blimited access to (?:e-?mail|my email)\b/, /\bback (?:on|in the office on)\b/,
    /\bchutti par\b/, /\bchhutti pe\b/, /\bleave pe hoon\b/, /\bbahar hoon\b.*\b(?:tak|until)\b/, /छुट्टी पर/,
  ]],
  ["wrong_person", [
    /\bwrong person\b/, /\bnot the right (?:person|contact)\b/, /\bno longer (?:with|at|working)\b/, /\bhas left (?:the company|the organi[sz]ation)\b/, /\bi (?:have|'ve) moved (?:on|to)\b/, /\bnot (?:responsible|handling|in charge of) (?:for )?(?:real estate|facilities|admin|office)\b/,
    /\b(?:please )?(?:reach out|contact|speak|write) to\b.*\b(?:instead|who handles|who looks after)\b/, /\bmain (?:ye|yeh) (?:nahi|nahin) dekhta\b/, /\bye (?:mera|meri) (?:kaam|department) nahi\b/, /\bgalat (?:person|aadmi|insaan)\b/, /\bunse baat karo\b/,
  ]],
  ["not_interested", [
    /\bnot interested\b/, /\bno thanks?\b/, /\bno,? thank you\b/, /\bno need\b/, /\bnot (?:looking|required|needed)\b/, /\bwe(?:'re| are) (?:all )?set\b/, /\bhappy with (?:our|the) current\b/, /\balready (?:have|signed|renewed|working with) (?:a |an )?(?:broker|consultant|agreement|lease|space)?/, /\bplease don'?t follow up\b/,
    /\binterest(?:ed)? nahi\b/, /\bzarurat nahi\b/, /\bzaroorat nahi\b/, /\bnahi chahiye\b/, /\brequirement nahi hai\b/, /\bkoi requirement nahi\b/, /रुचि नहीं|ज़रूरत नहीं|जरूरत नहीं|नहीं चाहिए/,
  ]],
  ["meeting", [
    /\b(?:let'?s|lets|can we|could we|happy to) (?:meet|catch up|connect|talk|speak|do a call|have a call|set up a call)\b/, /\bschedule (?:a )?(?:call|meeting)\b/, /\b(?:call|meet) (?:me )?(?:on|at|tomorrow|next|this) (?:mon|tue|wed|thu|fri|sat|sun|morning|afternoon|evening|week|\d)/, /\bfree (?:on|at|tomorrow|this|next)\b/, /\bsend (?:me )?(?:a |an )?(?:calendar )?invite\b/, /\bsite visit\b/,
    /\bmilte hain\b/, /\bmil(?:te| lete) hain\b/, /\bcall karte hain\b/, /\bbaat karte hain\b/, /\bkal (?:call|baat|milte)\b/, /\bmeeting (?:rakh|fix|set) (?:lo|karo|kar lete)\b/, /मिलते हैं|कॉल करते हैं/,
  ]],
  ["not_now", [
    /\bnot (?:right )?now\b/, /\bmaybe later\b/, /\b(?:next|after) (?:quarter|year|month|financial year|fy)\b/, /\bcircle back\b/, /\breach out (?:again )?(?:in|after|later)\b/, /\bget back to you (?:later|in)\b/, /\btoo early\b/, /\bnot a priority\b/, /\bon hold\b/, /\bbudget (?:freeze|not approved)\b/,
    /\babhi nahi\b/, /\babhi (?:koi )?(?:plan|requirement) nahi\b/, /\bbaad mein\b/, /\bthode (?:din|time) baad\b/, /\bnext (?:mahine|saal)\b/, /\bagle (?:mahine|saal|quarter)\b/, /अभी नहीं|बाद में/,
  ]],
  ["info_requested", [
    /\b(?:please |pls |kindly )?(?:send|share|forward|mail)\b.*\b(?:details|options|brochure|deck|proposal|list|info|information|rates?|pricing|quote|availability|floor ?plans?)\b/, /\bwhat (?:are|is) the (?:rates?|rent|pricing|availability)\b/, /\bcan you share\b/, /\bmore (?:details|information|info)\b/,
    /\b(?:details|options|brochure|rates?) (?:bhejo|bhej do|bhejiye|share karo|share kariye|send karo)\b/, /\bbhej (?:do|dijiye|dena)\b/, /\bkya rate\b/, /\brate kya hai\b/, /विवरण भेजें|डिटेल्स भेजो/,
  ]],
  ["interested", [
    /\binterested\b/, /\bsounds (?:good|great|interesting)\b/, /\bkeen\b/, /\btell me more\b/, /\bwe are (?:looking|exploring|evaluating)\b/, /\bwe(?:'re| are) planning\b/, /\bthat (?:works|would help)\b/, /\byes,? (?:please|sure)\b/, /\bsure\b/,
    /\bhaan\b/, /\bha+n ji\b/, /\bthik hai\b/, /\btheek hai\b/, /\bchalega\b/, /\bachha (?:hai|idea)\b/, /\bdekhte hain\b/, /\binterest hai\b/, /\bdekh sakte hain\b/, /हाँ|ठीक है|दिलचस्पी है/,
  ]],
];

export function classifyReply(text: string): ReplyClassification {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ")} `;
  const hits: { label: ReplyClass; m: string }[] = [];
  for (const [label, res] of R) for (const re of res) { const m = re.exec(t); if (m) hits.push({ label, m: m[0].trim() }); }
  if (!hits.length) return { label: "unclear", confidence: "low", matched: [] };
  // "not interested" contains "interested": precedence order (array order) wins.
  let label = R.map(([l]) => l).find((l) => hits.some((h) => h.label === l))!;
  if (label === "meeting" && /\bnot (?:right )?now\b|\babhi nahi\b|\bon hold\b|\bnot a priority\b|अभी नहीं/.test(t)) label = "not_now";
  // "no requirement right now / abhi nahi, next quarter" is timing, not a refusal.
  if (label === "not_interested" && hits.some((h) => h.label === "not_now") && !/\bnot interested\b|interest(?:ed)? nahi|रुचि नहीं/.test(t)) label = "not_now";
  const same = hits.filter((h) => h.label === label);
  const conflicting = new Set(hits.map((h) => h.label)).size > 1 && !["unsubscribe", "out_of_office"].includes(label);
  return { label, confidence: same.length > 1 && !conflicting ? "high" : conflicting ? "medium" : same.length ? "medium" : "low", matched: same.map((h) => h.m).slice(0, 4) };
}
