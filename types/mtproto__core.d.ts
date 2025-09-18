declare module '@mtproto/core' {
  export default class MTProto {
    constructor(options: {
      api_id: number;
      api_hash: string;
      test?: boolean;
      storageOptions?: {
        path: string;
      };
    });

    call(method: string, params?: any, options?: any): Promise<any>;
  }
}