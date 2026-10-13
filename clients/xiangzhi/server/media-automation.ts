import type { Store } from './store.js';

/** Process only new collector messages, with one bounded model request at a time. */
export class MediaAutomation {
  private timer:ReturnType<typeof setInterval>|null=null;
  private closed=false;
  private pending:Promise<void>|null=null;
  private active:{kind:'image'|'voice';controller:AbortController}|null=null;
  constructor(private readonly store:Store,private readonly options:{
    recognize:(messageId:string,kind:'image'|'voice',signal:AbortSignal)=>Promise<void>;
    onComplete?:(conversationId:string)=>void;
    onFailure?:(conversationId:string,kind:'image'|'voice')=>void;
  }) {}
  start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();void this.tick();}
  invalidate(){if(!this.active)return;const s=this.store.read().settings;if(!(this.active.kind==='image'?s.autoRecognizeImages:s.autoTranscribeVoice))this.active.controller.abort();}
  stop(){this.closed=true;this.active?.controller.abort();if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick():Promise<void>{
    if(this.pending||this.closed)return this.pending??Promise.resolve();
    const state=this.store.read();
    const candidate=state.messages.find(m=>m.autoMediaEligible && m.role==='peer' && m.source==='wechat'
      && m.mediaStatus==='pending' && (m.kind==='image'?state.settings.autoRecognizeImages:m.kind==='voice'&&state.settings.autoTranscribeVoice)
      && state.conversations.some(c=>c.id===m.conversationId&&c.wechat?.enabled));
    if(!candidate)return Promise.resolve();
    const kind=candidate.kind as 'image'|'voice',controller=new AbortController();this.active={kind,controller};
    this.store.update(s=>{const message=s.messages.find(m=>m.id===candidate.id);if(message)message.autoMediaEligible=false;});
    this.pending=(async()=>{
      try{await this.options.recognize(candidate.id,kind,controller.signal);if(!this.closed&&!controller.signal.aborted)this.options.onComplete?.(candidate.conversationId);}
      catch{if(!this.closed&&!controller.signal.aborted)this.options.onFailure?.(candidate.conversationId,kind);}
      finally{if(this.active?.controller===controller)this.active=null;}
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
}
