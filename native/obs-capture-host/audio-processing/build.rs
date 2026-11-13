fn main() {
    println!("cargo:rerun-if-changed=rnnoise");
    println!("cargo:rerun-if-changed=rnnoise_bridge.c");
    cc::Build::new()
        .include("rnnoise/include")
        .include("rnnoise/src")
        .define("COMPILE_OPUS", None)
        .define("_CRT_SECURE_NO_WARNINGS", None)
        .flag_if_supported("/utf-8")
        .files([
            "rnnoise_bridge.c",
            "rnnoise/src/denoise.c",
            "rnnoise/src/rnn.c",
            "rnnoise/src/rnn_data.c",
            "rnnoise/src/rnn_reader.c",
            "rnnoise/src/pitch.c",
            "rnnoise/src/kiss_fft.c",
            "rnnoise/src/celt_lpc.c",
        ])
        .opt_level(3)
        .compile("lycan_rnnoise");
}
