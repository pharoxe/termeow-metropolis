export function createCrosshairBus(){
  const listeners=new Map<string,(time:number|null)=>void>();
  return {subscribe:(id:string,listener:(time:number|null)=>void)=>{listeners.set(id,listener);return()=>{listeners.delete(id);};},publish:(source:string,time:number|null)=>{for(const [id,listener] of listeners)if(id!==source)listener(time);}};
}
export type CrosshairBus=ReturnType<typeof createCrosshairBus>;
