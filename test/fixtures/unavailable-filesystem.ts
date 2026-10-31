const unexpected = async () => { throw new Error('unexpected filesystem capability in this fixture'); };
export const unavailableFilesystem = {write:unexpected,mkdir:unexpected,remove:unexpected};
