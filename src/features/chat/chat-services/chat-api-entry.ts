import { ChatAPIData } from "./chat-api-data";
import { ChatAPIDoc } from "./chat-api-doc";
import { ChatAPISimple } from "./chat-api-simple";
import { ChatAPIGPTs } from "./chat-api-gpts";
import { ChatAPIWeb } from "./chat-api-web";
import { PromptGPTProps } from "./models";

export const chatAPIEntry = async (props: PromptGPTProps) => {
  if (props.chatType === "simple") {
    return await ChatAPISimple(props);
  } else if (props.chatType === "web") {
    return await ChatAPIWeb(props);
  } else if (props.chatType === "data") {
    return await ChatAPIData(props);
  } else if (props.chatType === "doc") {
    return await ChatAPIDoc(props);
  } else if (props.chatType === "gpts") {
    return await ChatAPIGPTs(props);
  } else if (props.chatType === "mssql") {
    return await ChatAPIData(props);
  } else {
    return await ChatAPISimple(props);
  }
};


