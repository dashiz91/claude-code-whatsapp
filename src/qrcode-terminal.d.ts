declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }

  interface QrCodeTerminal {
    generate(
      qrText: string,
      options?: GenerateOptions,
      callback?: (qrcode: string) => void,
    ): void;
  }

  const qrcode: QrCodeTerminal;
  export default qrcode;
}
