// Convert rich contenteditable DOM back into the exact plain-text prompt.
// Pasting formatted text commonly creates <p>, <li>, or nested <div> elements;
// treating only <div> and <br> as line breaks silently joins those paragraphs.
export const BLOCK_ELEMENTS=new Set([
  'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT','FIELDSET',
  'FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6',
  'HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY',
  'TD','TFOOT','TH','THEAD','TR','UL'
]);

export function serializePromptEditor(node,root=false){
  if(!node)return '';
  if(node.dataset?.token)return node.dataset.token;
  if(node.nodeType===3)return node.textContent||'';
  if(node.nodeName==='BR')return '\n';
  const children=Array.from(node.childNodes||[]);
  const content=children.map(child=>serializePromptEditor(child)).join('');
  const tag=String(node.tagName||node.nodeName||'').toUpperCase();
  if(!root&&BLOCK_ELEMENTS.has(tag)&&!content.endsWith('\n'))return content+'\n';
  return content;
}
