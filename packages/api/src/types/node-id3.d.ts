declare module 'node-id3' {
  export interface Tags {
    title?: string;
    artist?: string;
    album?: string;
    trackNumber?: string;
    [key: string]: string | number | undefined;
  }

  const NodeID3: {
    read: (filepath: string) => Tags | false | undefined;
    update: (tags: Partial<Tags>, filepath: string) => boolean;
  };

  export default NodeID3;
}
