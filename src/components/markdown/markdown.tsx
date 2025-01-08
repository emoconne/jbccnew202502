import Markdoc from "@markdoc/markdoc";
import React, { FC } from "react";
import { Citation } from "../../features/chat/chat-ui/markdown/citation";
import { CodeBlock } from "./code-block";
import { citationConfig } from "./config";
import { Paragraph } from "./paragraph";

interface Props {
  content: string;
}

// カスタムリンクコンポーネント
const Link: FC<{ href?: string; children?: React.ReactNode }> = ({ href, children }) => {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

// リンクのカスタム設定
const linkConfig = {
  nodes: {
    link: {
      render: 'Link',
      attributes: {
        href: { type: String },
        title: { type: String },
      },
    },
  },
};

export const Markdown: FC<Props> = (props) => {
  const ast = Markdoc.parse(props.content);

  const content = Markdoc.transform(ast, {
    ...citationConfig,
    ...linkConfig,
  });

  return Markdoc.renderers.react(content, React, {
    components: { 
      Citation, 
      Paragraph, 
      CodeBlock,
      Link, // カスタムリンクコンポーネントを追加
    },
  });
};