/** A small XML reader for pom.xml and maven-metadata.xml: elements and text, no attributes or namespaces. */
export interface XmlNode {
  name: string;
  children: XmlNode[];
  /** Text directly inside the element, trimmed. */
  text: string;
}

export function parseXml(source: string): XmlNode {
  const text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => escapeText(body));
  const root: XmlNode = { name: '', children: [], text: '' };
  const stack = [root];
  const tag = /<(\/?)([^\s<>/]+)([^<>]*?)(\/?)>/g;
  let last = 0;
  for (const m of text.matchAll(tag)) {
    const top = stack[stack.length - 1];
    top.text += text.slice(last, m.index);
    last = m.index + m[0].length;
    const name = m[2].replace(/^.*:/, '');
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const node: XmlNode = { name, children: [], text: '' };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  const finish = (n: XmlNode) => {
    n.text = unescapeText(n.text.trim());
    n.children.forEach(finish);
  };
  finish(root);
  return root;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export const child = (node: XmlNode | undefined, name: string) => node?.children.find((c) => c.name === name);
export const children = (node: XmlNode | undefined, name: string) => node?.children.filter((c) => c.name === name) ?? [];
/** Follows a path of element names from `node`. */
export const at = (node: XmlNode | undefined, ...names: string[]) => names.reduce<XmlNode | undefined>((n, name) => child(n, name), node);
