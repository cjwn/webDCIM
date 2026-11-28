import Foundation
import CoreImage
import ImageIO

let args = CommandLine.arguments
guard args.count >= 4 else {
    fputs("Usage: rawdev <input> <output.jpg> <ev> [maxPx] [shadow] [highlight] [clipMaskPpm]\n", stderr)
    exit(2)
}

let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let ev = Float(args[3]) ?? 0.0
let maxPx = Double(args.count >= 5 ? (Double(args[4]) ?? 2048.0) : 2048.0) // <=0 表示原生满分辨率
let shadow = max(0.0, min(2.0, Double(args.count >= 6 ? (Double(args[5]) ?? 0.0) : 0.0)))
let highlight = max(0.0, min(2.0, Double(args.count >= 7 ? (Double(args[6]) ?? 0.0) : 0.0)))
let clipPpmPath = (args.count >= 8 && !args[7].isEmpty && args[7] != "0") ? args[7] : nil
let noisePct = max(0.0, min(5.0, Double(args.count >= 9 ? (Double(args[8]) ?? 0.3) : 0.3)))

guard let filter = CIRAWFilter(imageURL: inURL) else {
    fputs("CIRAWFilter failed to open input\n", stderr)
    exit(1)
}

let native = filter.nativeSize
let longest = max(Double(native.width), Double(native.height))
let scale = (maxPx > 0 && longest > maxPx && longest > 0) ? max(0.05, min(1.0, maxPx / longest)) : 1.0

// 全分辨率解拜耳；关闭默认亮度涂抹降噪（保留发丝/纹理），再做适度亮度锐化对齐机内 JPG 观感
filter.scaleFactor = 1.0
filter.exposure = ev
filter.isGamutMappingEnabled = true
filter.luminanceNoiseReductionAmount = 0.0
filter.sharpnessAmount = 1.0
if clipPpmPath != nil {
    // 关闭机内畸变拉伸，让底图与 dcraw_emu 物理传感器坐标 100% 像素对齐
    filter.isLensCorrectionEnabled = false
}

guard var image = filter.outputImage else {
    fputs("CIRAWFilter produced nil outputImage\n", stderr)
    exit(1)
}

if scale < 0.999, let lan = CIFilter(name: "CILanczosScaleTransform") {
    lan.setValue(image, forKey: kCIInputImageKey)
    lan.setValue(scale, forKey: kCIInputScaleKey)
    lan.setValue(1.0, forKey: kCIInputAspectRatioKey)
    if let scaledImg = lan.outputImage {
        image = scaledImg
    }
}

var remSh = shadow
var remHl = highlight
while (remSh > 0.001 || remHl > 0.001), let hs = CIFilter(name: "CIHighlightShadowAdjust") {
    let stepSh = min(1.0, remSh)
    let stepHl = min(1.0, remHl)
    hs.setValue(image, forKey: kCIInputImageKey)
    hs.setValue(stepSh, forKey: "inputShadowAmount")
    hs.setValue(1.0 - stepHl, forKey: "inputHighlightAmount")
    if let adjusted = hs.outputImage {
        image = adjusted
    }
    remSh = max(0.0, remSh - stepSh)
    remHl = max(0.0, remHl - stepHl)
}

if let sharp = CIFilter(name: "CISharpenLuminance") {
    sharp.setValue(image, forKey: kCIInputImageKey)
    sharp.setValue(0.45, forKey: kCIInputSharpnessKey)
    sharp.setValue(1.4, forKey: kCIInputRadiusKey)
    if let sharpened = sharp.outputImage {
        image = sharpened
    }
}

let context = CIContext(options: [.useSoftwareRenderer: false])
guard let srgbCS = CGColorSpace(name: CGColorSpace.sRGB) else {
    fputs("Failed to create sRGB colorspace\n", stderr)
    exit(1)
}

/// 解析 dcraw_emu -h -4 -H 0 -r 1 1 1 1 -o 0 输出的 16-bit 大端 PPM（物理传感器 0..65535，无白平衡/无色调曲线失真）
func parsePpm16(_ data: Data) -> (w: Int, h: Int, offset: Int)? {
    let bytes = [UInt8](data.prefix(256))
    guard bytes.count >= 11, bytes[0] == 0x50, bytes[1] == 0x36 else { return nil } // "P6"
    var idx = 2
    var tokens: [String] = []
    while tokens.count < 3 && idx < bytes.count {
        while idx < bytes.count && (bytes[idx] == 32 || bytes[idx] == 10 || bytes[idx] == 13 || bytes[idx] == 9) { idx += 1 }
        if idx < bytes.count && bytes[idx] == 35 { // '#' comment
            while idx < bytes.count && bytes[idx] != 10 { idx += 1 }
            continue
        }
        let start = idx
        while idx < bytes.count && !(bytes[idx] == 32 || bytes[idx] == 10 || bytes[idx] == 13 || bytes[idx] == 9) { idx += 1 }
        if start < idx, let s = String(bytes: bytes[start..<idx], encoding: .ascii) {
            tokens.append(s)
        }
    }
    guard tokens.count == 3, let w = Int(tokens[0]), let h = Int(tokens[1]), let maxv = Int(tokens[2]), maxv == 65535 else {
        return nil
    }
    let offset = idx + 1 // 跳过 maxv 后的单个空白字节
    guard offset + w * h * 6 <= data.count else { return nil }
    return (w, h, offset)
}

if let ppmPath = clipPpmPath, let ppmData = try? Data(contentsOf: URL(fileURLWithPath: ppmPath)),
   let ppm = parsePpm16(ppmData) {
    let extent = image.extent.integral
    let w = Int(extent.width)
    let h = Int(extent.height)
    if w > 0 && h > 0 {
        var outBuf = [UInt8](repeating: 0, count: w * h * 4)
        outBuf.withUnsafeMutableBytes { ptr in
            context.render(
                image,
                toBitmap: ptr.baseAddress!,
                rowBytes: w * 4,
                bounds: extent,
                format: .RGBA8,
                colorSpace: srgbCS
            )
        }

        // context.render(toBitmap:) 与 PPM 均为自顶向下（top-down）行序，y 轴一一对应
        let rw = ppm.w
        let rh = ppm.h
        let baseOff = ppm.offset
        let hiThresh: UInt16 = 64800 // 物理传感器三通道全部 >= 98.9% 饱和（彻底死白）
        let loThresh: UInt16 = 12    // 物理传感器三通道全部 <= 0.018% 黑电平（硬件归零死黑）
        let noiseThresh: UInt16 = noisePct > 0.0 ? UInt16(min(65535, Int(round(65535.0 * noisePct / 100.0)))) : 0

        ppmData.withUnsafeBytes { rawPtr in
            let p = rawPtr.bindMemory(to: UInt8.self)
            for y in 0..<h {
                let sy = (y * rh) / h
                let ppmRow = baseOff + sy * rw * 6
                let outRow = y * w * 4
                for x in 0..<w {
                    let sx = (x * rw) / w
                    let po = ppmRow + sx * 6
                    let r = (UInt16(p[po]) << 8) | UInt16(p[po + 1])
                    let g = (UInt16(p[po + 2]) << 8) | UInt16(p[po + 3])
                    let b = (UInt16(p[po + 4]) << 8) | UInt16(p[po + 5])
                    let o = outRow + x * 4
                    if r >= hiThresh && g >= hiThresh && b >= hiThresh {
                        outBuf[o] = 255
                        outBuf[o + 1] = UInt8(Int(outBuf[o + 1]) / 5)
                        outBuf[o + 2] = UInt8(Int(outBuf[o + 2]) / 5)
                        outBuf[o + 3] = 255
                    } else if r <= loThresh && g <= loThresh && b <= loThresh {
                        outBuf[o] = UInt8(Int(outBuf[o]) / 5)
                        outBuf[o + 1] = UInt8(min(255, Int(outBuf[o + 1]) / 4 + 35))
                        outBuf[o + 2] = 255
                        outBuf[o + 3] = 255
                    } else if noiseThresh > loThresh && r <= noiseThresh && g <= noiseThresh && b <= noiseThresh {
                        outBuf[o] = UInt8(min(255, Int(Double(outBuf[o]) * 0.45) + 64))
                        outBuf[o + 1] = UInt8(min(255, Int(Double(outBuf[o + 1]) * 0.45) + 122))
                        outBuf[o + 2] = UInt8(min(255, Int(Double(outBuf[o + 2]) * 0.45) + 142))
                        outBuf[o + 3] = 255
                    }
                }
            }
        }

        let data = Data(outBuf)
        let compImg = CIImage(
            bitmapData: data,
            bytesPerRow: w * 4,
            size: CGSize(width: w, height: h),
            format: .RGBA8,
            colorSpace: srgbCS
        )
        do {
            try context.writeJPEGRepresentation(
                of: compImg,
                to: outURL,
                colorSpace: srgbCS,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.90]
            )
            exit(0)
        } catch {
            fputs("writeJPEGRepresentation (clip) failed: \(error)\n", stderr)
            exit(1)
        }
    }
}

do {
    try context.writeJPEGRepresentation(
        of: image,
        to: outURL,
        colorSpace: srgbCS,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.86]
    )
} catch {
    fputs("writeJPEGRepresentation failed: \(error)\n", stderr)
    exit(1)
}
