'use strict';

var path = require('path');
var fs = require('fs');
var utf8 = require('utf8');
var Module = require('module');
var through2 = require('through2');
var ES = require('event-stream');
var File = require('vinyl');

var sourceMap = require('source-map');
var convertSourceMap = require('convert-source-map');

function ExecDevTools(options) {
    this.src = path.resolve(options.src);
    this.cmd = options.cmd;
    this.url = options.url || options.src ;
    this.useSourceStream = options.useSourceStream || false;
   	this.stream = null;
    this.rootDir = path.resolve(options.root || process.cwd()) + '/';
}

ExecDevTools.prototype.init = function(devtoolsLive) {
    this.output = devtoolsLive.options.devtools.destination;
    this.sourceDir = devtoolsLive.options.devtools.directory;

    this.devtoolsLive = devtoolsLive;

    this.filepath = this.output + '/' + this.url;

    var file = {
        path: this.src,
        url: this.url,
        src: this.url,
        tmp: this.src,
        plugin : this,
        output: this.filepath
    };

    devtoolsLive.registerFile(file);

    this.resolve(devtoolsLive, file);

};

ExecDevTools.prototype.resolve = function(devtoolsLive, file) {

    var ExecDevToolsTmpFile = new ExecDevToolsFile(devtoolsLive, file, this);
    this.cmd(
        this.useSourceStream ? file.tmp : ExecDevToolsTmpFile.createFileStream(file),
       	this.useSourceStream ? ExecDevToolsTmpFile.createWriteSourceStream() : ExecDevToolsTmpFile.createWriteStream(),
        devtoolsLive.onError
    );
};

function ExecDevToolsFile(devtoolsLive, file, plugin) {
    this.file = file;
    this.devtoolsLive = devtoolsLive;
    this.sourceDir = plugin.sourceDir;
    this.rootDir = plugin.rootDir;
    this.plugin = plugin;
}

ExecDevToolsFile.prototype.cleanSourceMap = function(generatedContent) {

    var fileSourceMap = null;
    var generator = new sourceMap.SourceMapGenerator({
        file: '/' + this.file.url
    });

    var isCSS = false;
    if(generatedContent.indexOf('/*# sourceMappingURL=')>0){
    	var isCSS = true;
    }

    var sourcemap = convertSourceMap.fromSource(generatedContent, true);

    if(sourcemap == null ) return '';

    sourcemap = sourcemap.toObject();

    var consumer = new sourceMap.SourceMapConsumer(sourcemap);

    consumer.eachMapping(function(m) {

        var path = m.source.replace(sourcemap.sourceRoot, '').replace(this.rootDir, '');
        var filepath = Module._findPath(path, [this.rootDir, this.sourceDir]).replace(this.sourceDir, '').replace(this.rootDir, '');

        if(filepath.charAt(0) == '/'){
        	filepath = filepath.substr(1);
        }

        generator.addMapping({
            source: '/' + filepath,
            original: { line: m.originalLine, column: m.originalColumn },
            generated: { line: m.generatedLine, column: m.generatedColumn }
        });

    }.bind(this), {}, consumer.ORIGINAL_ORDER);

    for (var i in sourcemap.sources) {

    	var path = sourcemap.sources[i].replace(sourcemap.sourceRoot, '').replace(this.rootDir, '');
        path = Module._findPath(path, [this.rootDir, this.sourceDir]);
        var filepath = path.replace(this.sourceDir, '').replace(this.rootDir, '');

        if(filepath.charAt(0) == '/'){
        	filepath = filepath.substr(1);
        }

        sourcemap.sources[i] = filepath;

    	var file = {
            path: path,
            url: filepath,
            src: this.plugin.url,
            tmp: this.plugin.src,
            plugin : this.plugin,
            output: this.filepath
        };
        this.devtoolsLive.registerFile(file);
    }

    sourcemap.mappings = generator.toJSON().mappings;
    sourcemap.file = '/' + this.file.url;

    sourcemap.sourceRoot = '/';

    return convertSourceMap.fromObject(sourcemap).toComment({ multiline: isCSS });

};

ExecDevToolsFile.prototype.saveFile = function(filepath, content) {
    var inline = this.cleanSourceMap(content);

    process.fs.mkdirpSync(path.dirname(this.plugin.filepath));

	if (inline !== ''){
    	content = convertSourceMap.removeComments(content);
    	process.fs.writeFileSync(this.plugin.filepath, content + '\n' + inline);
	}else{

		process.fs.writeFileSync(this.plugin.filepath, content);
	}

	this.devtoolsLive.streamFinished(this.plugin);

	return content;
}

ExecDevToolsFile.prototype.pushFile = function(content) {
    var record = {
        action: 'update',
        url: this.devtoolsLive.getClientPageUrl() + '/' +  this.plugin.url
    };


	if (this.file.content === undefined) {
		record.sync = this.file.src;
	} else {
		record.resourceName = this.file.src;
		delete this.file.content;
	}

	record.event = this.file.src;

    record.content = this.saveFile(this.file.output, content);

    this.devtoolsLive.broadcast(record);

};

ExecDevToolsFile.prototype.createWriteStream = function() {

	var modifyFile = function(file) {
        if (file.contents.length > 0) {
            this.pushFile(file.contents.toString());
        } else {
            this.pushFile('/** empty **/');
        }
    }.bind(this);

    return ES.through(modifyFile);

};

ExecDevToolsFile.prototype.createWriteSourceStream = function() {

	var data = []; // We'll store all the data inside this array
    var writeStream = function (chunk) {
      data.push(chunk);
    };
    var endStream  = function() { // Will be emitted when the input stream has ended, ie. no more data will be provided
      this.pushFile(Buffer.concat(data).toString());
    }.bind(this);

    return ES.through(writeStream, endStream);

};

ExecDevToolsFile.prototype.createFileStream = function() {

	var data = fs.readFileSync(this.file.tmp);

	var file = new File({
		path: this.file.tmp,
		cwd : path.dirname(this.file.tmp),
		contents: ((data instanceof Buffer) ? data : new Buffer(data))
	});

	var stream = through2.obj(function(file, enc, callback) {
		this.push(file);
		return callback();
	});

	stream.write(file);

	return stream;


};

module.exports = ExecDevTools;
