import {createContext} from 'react';
import type {Kind,StudioNodeData} from './types';
import type {DoubaoAccount,ReferenceNode} from './doubao';
import type {MuseAccount} from './muse';
import type {ChatGPTAccount} from './chatgpt';

type Actions={
  update:(id:string,patch:Partial<StudioNodeData>)=>void;
  generate:(id:string,kind?:Kind)=>void;
  addAfter:(id:string,kind:Kind)=>void;
  addBefore:(id:string,kind:Kind)=>void;
  openNodeMenu:(id:string,side:'source'|'target',x:number,y:number)=>void;
  uploadFor:(id:string,file:File)=>Promise<void>;
  extractLastFrame:(id:string)=>Promise<void>;
  openFrameEditor:(id:string)=>void;
  duplicate:(id:string)=>void;
  remove:(id:string)=>void;
  expand:(id:string)=>void;
  inspect:(id:string)=>void;
  accounts:DoubaoAccount[];
  museAccounts:MuseAccount[];
  chatgptAccounts:ChatGPTAccount[];
  referencesFor:(id:string)=>ReferenceNode[];
  reorderReferences:(nodeId:string,referenceId:string,direction:-1|1,currentPrompt?:string)=>void;
  openAccountsSettings:()=>void;
  openMuseAccountsSettings:()=>void;
  openH3Settings:()=>void;
  openChatGPTSettings:()=>void;
  openAccountBrowser:(id:string)=>Promise<void>;
  openMuseAccountBrowser:(id:string)=>Promise<void>;
};

export const StudioActionsContext=createContext<Actions|null>(null);
