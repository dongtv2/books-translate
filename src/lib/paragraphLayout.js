// Single source of truth for the paragraph-number gutter and the English /
// Vietnamese / notes column ratio, shared by the column header row and every
// paragraph row so they always line up exactly — this is what makes a section
// read as one continuous facing-page spread instead of a stack of cards.
// The notes column can be hidden from the chapter's display settings.
export function paragraphGridCols(showNotes) {
  return showNotes
    ? 'lg:grid-cols-[2.75rem_minmax(0,1fr)_minmax(0,1fr)_minmax(12rem,0.62fr)]'
    : 'lg:grid-cols-[2.75rem_minmax(0,1fr)_minmax(0,1fr)]';
}
