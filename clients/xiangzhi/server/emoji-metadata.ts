const md5Pattern=/^[a-fA-F0-9]{32}$/;

/** Project only identifiers from a bounded emoji tag/object, not CDN URLs or XML. */
export function wechatEmojiMetadata(content:unknown,localId?:string):{md5?:string;localId?:string}|undefined {
  const hashes=new Set<string>();let visited=0,overLimit=false;
  const collect=(value:unknown,depth:number,emojiObject=false):void=>{
    if(++visited>80||depth>5){overLimit=true;return;}
    if(typeof value==='string'){
      if(value.length>32_000){overLimit=true;return;}
      for(const tag of value.matchAll(/<emoji\b[^>]{0,16000}>/gi)){
        const match=/\smd5\s*=\s*(["'])([a-fA-F0-9]{32})\1/i.exec(tag[0]);
        if(match)hashes.add(match[2].toLowerCase());
      }
      return;
    }
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const object=value as Record<string,unknown>;
    if(emojiObject&&typeof object.md5==='string'&&md5Pattern.test(object.md5))hashes.add(object.md5.toLowerCase());
    const entries=Object.entries(object);if(entries.length>24)overLimit=true;
    for(const [key,nested] of entries.slice(0,24))collect(nested,depth+1,emojiObject||/^(?:emoji|emoticon)$/i.test(key));
  };
  collect(content,0);
  const md5=!overLimit&&hashes.size===1?[...hashes][0]:undefined;
  return md5||localId?{...(md5?{md5}:{}),...(localId?{localId}:{})}:undefined;
}
