declare const pluginExport: Record<string, any> & {
    __openclaw: {
        compat: {
            pluginApi: string;
        };
        build: {
            openclawVersion: string;
        };
    };
};
export default pluginExport;
