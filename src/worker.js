const LineByLineReader = require('line-by-line')
const init = require('./00-init-db');
const log4js = require('log4js');
const config = require('../config')

log4js.configure({
  appenders: {
    cheese: {
      type: 'file',
      filename: __dirname + '/../worker.logs'
    }
  },
  categories: {
    default: {
      appenders: ['cheese'],
      level: 'info'
    }
  }
});
const logger = log4js.getLogger('cheese');

const xmlSplit = async (options, chunkSize, workerNr) => {
  var insertToDb,
    lineNumber,
    lr,
    page,
    pageCount,
    pages,
    skipPage;

  if (workerNr === 0) {
    startByte = 0
  } else {
    // start a megabyte earlier
    startByte = (workerNr * chunkSize) - 1000000
  }
  // end 2 megabytes later so we don't lose pages cut by chunks
  endByte = startByte + chunkSize + 3000000

  logger.info(`worker pid:${process.pid} is now alive. startByte: ${startByte} endByte: ${endByte}`)
  await init(options)

  lr = new LineByLineReader(options.file, {
    start: startByte,
    end: endByte
  });
  lineNumber = 0;
  page = null;
  pageCount = 0;
  pages = [];
  skipPage = false;
  workerBegin = Date.now()
  jobBegin = Date.now()

  insertToDb = function() {
    var insertMany;
    if (pages.length === 0) {
      // shouldn't happen.
      return logger.error("err: empty pages arr");
    }
    lr.pause();
    insertMany = Object.assign([], pages);
    logger.info("inserting", insertMany.length, "documents. first:", insertMany[0]._id, "and last:", insertMany[insertMany.length - 1]._id);
    pages = [];
    options.db.collection(config.queueLocation).insertMany(insertMany, function() {
      // tbd. error checks
    });
    logger.info("batch complete in: " + ((Date.now() - jobBegin) / 1000) + " secs")
    jobBegin = Date.now()
    return lr.resume();
  };

  lr.on('error', function(err) {
    // 'err' contains error object
    console.error(err)
    return logger.error("linereader error");
  });

  lr.on('line', function(line) {
    lineNumber++;
    if (page) {
      page.body += line;
      if (!page.title) {
        if (line.indexOf("<title>") !== -1) {
          page._id = line.substring(line.lastIndexOf("<title>") + 7, line.lastIndexOf("</title>"));
        }
      }
      //skip any pages not in the '0' namespace
      if (line.indexOf("<ns>") !== -1 && line.indexOf("<ns>0</ns>") === -1) {
        skipPage = true;
      }
      //skip pages that are a redirect, too
      if (line.indexOf("<redirect title=") !== -1) {
        skipPage = true;
      }
    }
    if (line.indexOf("<page>") !== -1) {
      page = {
        body: line,
        lr: lineNumber
      };
      pageCount++;
    }
    if (page && line.indexOf("</page>") !== -1) {
      if (!skipPage) {
        pages.push(page);
      }
      skipPage = false;
      page = null;
      if (pageCount % options.batch_size === 0) {
        insertToDb();
      }
    }
  });
  return lr.on('end', function() {
    // All lines are read, file is closed now.
    // insert remaining pages.
    insertToDb();
    logger.info(`worker pid:${process.pid} is done. inserted ${pageCount} pages in ${((Date.now() - jobBegin) / 1000)} secs.`);
    // process.exit()
    return
  });
};

module.exports = xmlSplit
