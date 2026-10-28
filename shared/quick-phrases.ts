import type { LanguageCode } from './languages'
// These deliberately express no agreement, understanding, or commitment.
export const quickPhraseLabels = ['Thinking time', 'Repetition', 'Slower speech', 'Clarification', 'Transition']
export const quickPhrases: Record<LanguageCode, readonly string[]> = {
  en: ['Let me think for a moment.', 'Could you repeat that, please?', 'Could you speak a little more slowly?', 'What do you mean by that?', 'May I bring up another point?'],
  it: ['Mi lasci pensare un momento.', 'Può ripetere, per favore?', 'Può parlare un po’ più lentamente?', 'Che cosa intende con questo?', 'Posso passare a un altro punto?'],
  es: ['Déjeme pensar un momento.', '¿Puede repetirlo, por favor?', '¿Puede hablar un poco más despacio?', '¿Qué quiere decir con eso?', '¿Puedo plantear otro punto?'],
  fr: ['Laissez-moi réfléchir un instant.', 'Pouvez-vous répéter, s’il vous plaît ?', 'Pouvez-vous parler un peu plus lentement ?', 'Que voulez-vous dire par là ?', 'Puis-je aborder un autre point ?'],
  de: ['Lassen Sie mich kurz nachdenken.', 'Können Sie das bitte wiederholen?', 'Können Sie etwas langsamer sprechen?', 'Was meinen Sie damit?', 'Darf ich einen weiteren Punkt ansprechen?'],
  ru: ['Дайте мне немного подумать.', 'Повторите, пожалуйста.', 'Вы можете говорить немного медленнее?', 'Что вы имеете в виду?', 'Можно перейти к другому вопросу?'],
}
