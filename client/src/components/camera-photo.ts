// Re-encoding also applies browser image orientation and drops location metadata.
export function jpegFrame(source: HTMLImageElement | HTMLVideoElement, width: number, height: number): string {
    if (!width || !height) throw new Error("The camera frame is still loading.");
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser couldn’t prepare the photo.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL("image/jpeg", .9);
    if (photo.length - "data:image/jpeg;base64,".length <= 4 * 1024 * 1024) return photo;
    return canvas.toDataURL("image/jpeg", .75);
}

export async function readCameraPhoto(file: File): Promise<string> {
    if (file.size > 32 * 1024 * 1024) throw new Error("Choose a photo smaller than 32 MB.");
    if (file.type && !/^image\/(jpe?g|png|webp|heif|heic)$/i.test(file.type)) {
        throw new Error("Choose a JPEG, PNG or WebP photo.");
    }
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        try { await image.decode(); }
        catch { throw new Error("This photo couldn’t be opened. Choose a JPEG, PNG or WebP copy."); }
        return jpegFrame(image, image.naturalWidth, image.naturalHeight);
    } finally {
        URL.revokeObjectURL(url);
    }
}
