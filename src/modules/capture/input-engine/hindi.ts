/**
 * Devanagari Hindi -> Roman-script Hinglish for the rule extractor (spec §2.2: English, Hindi, Hinglish).
 * Deterministic: a CRE / everyday-word dictionary first (spellings the Hinglish rules understand), then a plain
 * transliteration with end-schwa deletion. Words not in the dictionary are capitalised (likely names/places), so
 * "अनिल" -> "Anil". The original Devanagari text is always kept next to the romanised text.
 */
const DICT: Record<string, string> = {
  "बात": "baat", "हुई": "hui", "हुयी": "hui", "की": "ki", "का": "ka", "के": "ke", "से": "se", "को": "ko", "में": "mein", "मे": "mein", "पर": "par", "और": "aur", "या": "ya",
  "है": "hai", "हैं": "hain", "था": "tha", "थी": "thi", "तक": "tak", "पहले": "pehle", "बाद": "baad", "मिला": "mila", "मिले": "mile", "मिली": "mili", "मुलाकात": "mulakat",
  "चाहिए": "chahiye", "चाहिये": "chahiye", "जगह": "jagah", "ऑफिस": "office", "ऑफ़िस": "office", "दफ्तर": "office", "बजट": "budget", "किराया": "kiraya", "रुपये": "rupaye", "रुपए": "rupaye",
  "हजार": "hazaar", "हज़ार": "hazaar", "लाख": "lakh", "करोड़": "crore", "करोड": "crore", "सौ": "sau",
  "एक": "ek", "दो": "2", "तीन": "3", "चार": "4", "पांच": "paanch", "पाँच": "paanch", "छह": "chhah", "सात": "saat", "आठ": "aath", "नौ": "nau", "दस": "10",
  "बीस": "bees", "पच्चीस": "pachees", "तीस": "tees", "चालीस": "chalis", "पचास": "pachaas", "साठ": "saath", "सत्तर": "sattar", "अस्सी": "assi", "नब्बे": "nabbe", "डेढ़": "dedh", "ढाई": "dhai",
  "स्क्वेयर": "sq", "स्क्वायर": "sq", "फीट": "ft", "फुट": "ft", "स्क्वेयरफीट": "sq ft", "सीट": "seats", "सीटें": "seats",
  "भेजना": "bhejna", "भेजने": "bhejne", "भेजेगा": "bhejega", "भेजेगी": "bhejegi", "भेजेंगे": "bhejenge", "भेज": "bhej", "देना": "dena", "करना": "karna", "करेगा": "karega",
  "ऑप्शन": "options", "ऑप्शंस": "options", "ऑप्शन्स": "options", "विकल्प": "options", "प्लान": "plan", "फ्लोर": "floor", "कॉल": "call", "मीटिंग": "meeting", "ईमेल": "email", "व्हाट्सएप": "whatsapp",
  "लगभग": "lagbhag", "करीब": "lagbhag", "शायद": "shayad", "महंगा": "mehenga", "बहुत": "bahut", "दूर": "door", "पसंद": "pasand", "नहीं": "nahin", "कल": "kal", "आज": "aaj", "लीज": "lease", "लॉक-इन": "lock-in",
  "सोमवार": "somvar", "मंगलवार": "mangalvar", "बुधवार": "budhvar", "गुरुवार": "guruvar", "शुक्रवार": "shukravar", "शनिवार": "shanivar", "रविवार": "ravivar",
  "जनवरी": "January", "फरवरी": "February", "मार्च": "March", "अप्रैल": "April", "मई": "May", "जून": "June", "जुलाई": "July", "अगस्त": "August", "सितंबर": "September", "सितम्बर": "September",
  "अक्टूबर": "October", "नवंबर": "November", "नवम्बर": "November", "दिसंबर": "December", "दिसम्बर": "December",
  "उनको": "unko", "उन्हें": "unhe", "उन्हे": "unhe", "उनका": "unka", "उनकी": "unki", "उनके": "unke", "इनको": "inko", "इन्हें": "inhe", "इनका": "inka",
  "उसको": "usko", "इसको": "isko", "हम": "hum", "हमें": "hume", "हमको": "humko", "हमारा": "hamara", "मुझे": "mujhe", "आप": "aap", "आपको": "aapko", "वो": "woh", "वह": "woh", "ये": "ye", "यह": "yeh",
  "वाला": "wala", "वाले": "wale", "वाली": "wali", "भी": "bhi", "तो": "to", "पे": "pe", "ही": "hi",
  "खराडी": "Kharadi", "खराड़ी": "Kharadi", "बाणेर": "Baner", "बानेर": "Baner", "हिंजवडी": "Hinjewadi", "हिंजेवाड़ी": "Hinjewadi", "मगरपट्टा": "Magarpatta", "विमाननगर": "Viman Nagar",
  "विमान": "Viman", "नगर": "Nagar", "पुणे": "Pune", "औंध": "Aundh", "हडपसर": "Hadapsar", "येरवडा": "Yerwada", "कल्याणीनगर": "Kalyani Nagar", "वाकड": "Wakad",
};

const V: Record<string, string> = { "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o" };
const M: Record<string, string> = { "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ं": "n", "ँ": "n", "ः": "h" };
const C: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f", "ळ": "l",
};
const VIRAMA = "्", NUKTA = "़";

export const hasDevanagari = (s: string) => /[ऀ-ॿ]/.test(s);

function translit(word: string): string {
  let out = "";
  const ch = [...word];
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i];
    if (ch[i + 1] === NUKTA) { c += NUKTA; i++; }
    if (V[c]) { out += V[c]; continue; }
    if (M[c] !== undefined) { out += M[c]; continue; }
    if (C[c] !== undefined) {
      out += C[c];
      const nx = ch[i + 1];
      if (nx === VIRAMA) { i++; continue; }
      if (nx && (M[nx] !== undefined && !["ं", "ँ", "ः"].includes(nx))) continue;   // matra supplies the vowel
      out += "a";                                                                     // inherent vowel
      continue;
    }
    if (/[०-९]/.test(c)) { out += String(c.charCodeAt(0) - 0x0966); continue; }
    out += c === "।" ? "." : c;
  }
  return out.length > 2 ? out.replace(/a$/, "") : out;                              // end-schwa deletion
}

/** Romanise every Devanagari word; Latin text, digits and punctuation pass through unchanged. */
export function romanise(text: string): string {
  const joined = text.replace(/स्क्वेयर\s+फीट|स्क्वायर\s+फीट/g, "sq ft").replace(/विमान\s+नगर/g, "Viman Nagar").replace(/।/g, ".");
  return joined.replace(/[ऀ-ॿ]+/g, (w) => {
    if (DICT[w]) return DICT[w];
    const digits = /^[०-९]+$/.test(w);
    const r = translit(w);
    return digits ? r : r.charAt(0).toUpperCase() + r.slice(1);
  });
}

export type Lang = "en" | "hi" | "hinglish";
/** Language of a transcript: Devanagari => hi; Roman text with Hindi function words => hinglish; else en. */
export function detectLanguage(text: string): Lang {
  if (hasDevanagari(text)) return "hi";
  return /\b(hai|hain|se|ko|ka|ki|ke|tak|mein|chahiye|bhejna|baat|hui|mila|nahi|kal|hazaar|lakh|ho sakta)\b/i.test(text) ? "hinglish" : "en";
}
