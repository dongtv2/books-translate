import { RemarksList, RichText } from '../lib/markdownLite.jsx';
import { fontSizeClass } from '../context/LayoutSettingsContext.jsx';

// Margin notes beside a paragraph. Set in the interface face and a size
// smaller than the book text so they read as annotation, not as a third
// column of prose.
// Citations (citations_md) are not here: they sit in the paragraph's own
// citation row, next to the citation text in the English/Vietnamese columns.
export default function ParagraphRemarks({ phrasesVerbsMd, vocabularyMd, remarksNote, fontSize = 'base' }) {
  const headingClass = `mb-1 font-semibold ${fontSizeClass('remarksHeading', fontSize)}`;
  const bodyClass = fontSizeClass('remarksBody', fontSize);

  const hasAny = phrasesVerbsMd?.trim() || vocabularyMd?.trim() || remarksNote?.trim();
  if (!hasAny) return null;

  return (
    <div className="space-y-3.5 text-soft">
      {phrasesVerbsMd?.trim() && (
        <div>
          <p className={`${headingClass} text-accent`}>Phrases &amp; Verbs</p>
          <RemarksList text={phrasesVerbsMd} itemClassName={bodyClass} />
        </div>
      )}
      {vocabularyMd?.trim() && (
        <div>
          <p className={`${headingClass} text-ok`}>Vocabulary</p>
          <RemarksList text={vocabularyMd} itemClassName={bodyClass} />
        </div>
      )}
      {remarksNote?.trim() && (
        <div className="border-l-2 border-warn/50 pl-3">
          <p className={`${headingClass} text-warn`}>Ghi chú</p>
          <RichText text={remarksNote} className={`block leading-relaxed ${bodyClass}`} />
        </div>
      )}
    </div>
  );
}
