'use strict';

/**
 * Server-side hooks
 *
 * @see {@link http://etherpad.org/doc/v1.5.7/#index_server_side_hooks}
 */

const eejs = require('ep_etherpad-lite/node/eejs/');
const settings = require('ep_etherpad-lite/node/utils/Settings');
const Busboy = require('busboy');
const StreamUpload = require('stream_upload');
const uuid = require('uuid');
const path = require('path');
const mimetypes = require('mime-db');
const url = require('url');
const fs = require('fs');

/**
 * ClientVars hook
 *
 * Exposes plugin settings from settings.json to client code inside clientVars variable
 * to be accessed from client side hooks
 *
 * @param {string} hookName Hook name ("clientVars").
 * @param {object} args Object containing the arguments passed to hook. {pad: {object}}
 * @param {function} cb Callback
 *
 * @returns {*} callback
 *
 * @see {@link http://etherpad.org/doc/v1.5.7/#index_clientvars}
 */
exports.clientVars = (hookName, args, cb) => {
  const pluginSettings = {
    storageType: 'base64',
  };
  if (!settings.ep_image_upload) {
    settings.ep_image_upload = {};
  }
  const keys = Object.keys(settings.ep_image_upload);
  keys.forEach((key) => {
    if (key !== 'storage') {
      pluginSettings[key] = settings.ep_image_upload[key];
    }
  });
  if (settings.ep_image_upload.storage && settings.ep_image_upload.storage.type !== 'base64') {
    pluginSettings.storageType = settings.ep_image_upload.storage.type;
  }

  if (!pluginSettings) {
    console.warn(hookName,
        'ep_image_upload settings not found. The settings can be specified in EP settings.json.'
    );

    return cb();
  }
  pluginSettings.mimeTypes = mimetypes;

  return cb({ep_image_upload: pluginSettings});
};

exports.eejsBlock_body = (hookName, args, cb) => {
  const modal = eejs.require('ep_image_upload/templates/modal.ejs');
  args.content += modal;

  return cb();
};

exports.eejsBlock_styles = (hookName, args, cb) => {
  const style = eejs.require('ep_image_upload/templates/styles.ejs');
  args.content += style;

  return cb();
};

const drainStream = (stream) => {
  stream.on('readable', stream.read.bind(stream));
};

exports.expressConfigure = (hookName, context) => {
  context.app.post('/p/:padId/pluginfw/ep_image_upload/upload', (req, res, next) => {
    const padId = req.params.padId;
    let busboy;
    const imageUpload = new StreamUpload({
      extensions: settings.ep_image_upload.fileTypes,
      maxSize: settings.ep_image_upload.maxFileSize,
      baseFolder: settings.ep_image_upload.storage.baseFolder,
      storage: settings.ep_image_upload.storage,
    });
    const storageConfig = settings.ep_image_upload.storage;
    if (storageConfig) {
      try {
        busboy = new Busboy({
          headers: req.headers,
          limits: {
            fileSize: settings.ep_image_upload.maxFileSize,
          },
        });
      } catch (error) {
        console.error('EP_IMAGE_UPLOAD ERROR', error);

        return next(error);
      }

      let isDone;
      const done = (error) => {
        if (error) {
          console.error('EP_IMAGE_UPLOAD UPLOAD ERROR', error);

          return;
        }

        if (isDone) return;
        isDone = true;

        res.status(error.statusCode || 500).json(error);
        req.unpipe(busboy);
        drainStream(req);
        busboy.removeAllListeners();
      };

      let uploadResult;
      const newFileName = uuid.v4();
      let accessPath = '';
      busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        let savedFilename = path.join(padId, newFileName + path.extname(filename));

        if (settings.ep_image_upload.storage && settings.ep_image_upload.storage.type === 'local') {
          let baseURL = settings.ep_image_upload.storage.baseURL;
          if (baseURL.charAt(baseURL.length - 1) !== '/') {
            baseURL += '/';
          }
          accessPath = new url.URL(savedFilename, settings.ep_image_upload.storage.baseURL);
          savedFilename = path.join(settings.ep_image_upload.storage.baseFolder, savedFilename);
        }
        file.on('limit', () => {
          const error = new Error('File is too large');
          error.type = 'fileSize';
          error.statusCode = 403;
          busboy.emit('error', error);
          imageUpload.deletePartials();
        });
        file.on('error', (error) => {
          busboy.emit('error', error);
        });

        uploadResult = imageUpload
            .upload(file, {type: mimetype, filename: savedFilename});
      });

      busboy.on('error', done);
      busboy.on('finish', () => {
        if (uploadResult) {
          uploadResult
              .then((data) => {
                if (accessPath) {
                  data = accessPath;
                }

                return res.status(201).json(data);
              })
              .catch((err) => res.status(500).json(err));
        }
      });
      req.pipe(busboy);
    }
  });
};

exports.padRemove = async (hookName, context) => {
  // If storageType is local, delete the folder for the images
  const {ep_image_upload: {storage: {type, baseFolder} = {}} = {}} = settings;
  if (type === 'local') {
    const dir = path.join(baseFolder, context.padID);
    await fs.promises.rmdir(dir, {recursive: true});
  }
};
