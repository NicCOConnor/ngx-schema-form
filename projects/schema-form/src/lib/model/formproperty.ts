import {Observable, BehaviorSubject, combineLatest} from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';

import {SchemaValidatorFactory} from '../schemavalidatorfactory';
import {ValidatorRegistry} from './validatorregistry';

export abstract class FormProperty {
  public schemaValidator: Function;

  _value: any = null;
  _errors: any = null;
  private _valueChanges = new BehaviorSubject<any>(null);
  private _errorsChanges = new BehaviorSubject<any>(null);
  private _visible = true;
  private _visibilityChanges = new BehaviorSubject<boolean>(true);
  private _root: PropertyGroup;
  private _parent: PropertyGroup;
  private _path: string;

  constructor(schemaValidatorFactory: SchemaValidatorFactory,
              private validatorRegistry: ValidatorRegistry,
              public schema: any,
              parent: PropertyGroup,
              path: string) {
    this.schemaValidator = schemaValidatorFactory.createValidatorFn(this.schema);

    this._parent = parent;
    if (parent) {
      this._root = parent.root;
    } else if (this instanceof PropertyGroup) {
      this._root = <PropertyGroup><any>this;
    }
    this._path = path;
  }

  public get valueChanges() {
    return this._valueChanges;
  }

  public get errorsChanges() {
    return this._errorsChanges;
  }

  public get type(): string {
    return this.schema.type;
  }

  public get parent(): PropertyGroup {
    return this._parent;
  }

  public get root(): PropertyGroup {
    return this._root || <PropertyGroup><any>this;
  }

  public get path(): string {
    return this._path;
  }

  public get value() {
    return this._value;
  }

  public get visible() {
    return this._visible;
  }

  public get valid() {
    return this._errors === null;
  }

  public abstract setValue(value: any, onlySelf: boolean);

  public abstract reset(value: any, onlySelf: boolean);

  public updateValueAndValidity(onlySelf = false, emitEvent = true) {
    this._updateValue();

    if (emitEvent) {
      this.valueChanges.next(this.value);
    }

    this._runValidation();

    if (this.parent && !onlySelf) {
      this.parent.updateValueAndValidity(onlySelf, emitEvent);
    }

  }

  /**
   * @internal
   */
  public abstract _hasValue(): boolean;

  /**
   *  @internal
   */
  public abstract _updateValue();

  /**
   * @internal
   */
  public _runValidation(): any {
    let errors = this.schemaValidator(this._value) || [];
    let customValidator = this.validatorRegistry.get(this.path);
    if (customValidator) {
      let customErrors = customValidator(this.value, this, this.findRoot());
      errors = this.mergeErrors(errors, customErrors);
    }
    if (errors.length === 0) {
      errors = null;
    }

    this._errors = errors;
    this.setErrors(this._errors);
  }

  private mergeErrors(errors, newErrors) {
    if (newErrors) {
      if (Array.isArray(newErrors)) {
        errors = errors.concat(...newErrors);
      } else {
        errors.push(newErrors);
      }
    }
    return errors;
  }

  private setErrors(errors) {
    this._errors = errors;
    this._errorsChanges.next(errors);
  }

  public extendErrors(errors) {
    errors = this.mergeErrors(this._errors || [], errors);
    this.setErrors(errors);
  }

  searchProperty(path: string): FormProperty {
    let prop: FormProperty = this;
    let base: PropertyGroup = null;

    let result = null;
    if (path[0] === '/') {
      base = this.findRoot();
      result = base.getProperty(path.substr(1));
    } else {
      while (result === null && prop.parent !== null) {
        prop = base = prop.parent;
        result = base.getProperty(path);
      }
    }
    return result;
  }

  public findRoot(): PropertyGroup {
    let property: FormProperty = this;
    while (property.parent !== null) {
      property = property.parent;
    }
    return <PropertyGroup>property;
  }

  private setVisible(visible: boolean) {
    this._visible = visible;
    this._visibilityChanges.next(visible);
    this.updateValueAndValidity();
    if (this.parent) {
      this.parent.updateValueAndValidity(false, true);
    }
  }

  private __bindVisibility(): boolean {
    /**
     * <pre>
     *     "oneOf":[{
     *         "path":["value","value"]
     *     },{
     *         "path":["value","value"]
     *     }]
     *     </pre>
     * <pre>
     *     "allOf":[{
     *         "path":["value","value"]
     *     },{
     *         "path":["value","value"]
     *     }]
     *     </pre>
     */
    const visibleIfProperty = this.schema.visibleIf
    const visibleIfOf = (visibleIfProperty || {}).oneOf || (visibleIfProperty || {}).allOf;
    if (visibleIfOf) {
      for (const visibleIf of visibleIfOf) {
        if (typeof visibleIf === 'object' && Object.keys(visibleIf).length === 0) {
          this.setVisible(false);
        } else if (visibleIf !== undefined) {
          const propertiesBinding = [];
          for (const dependencyPath in visibleIf) {
            if (visibleIf.hasOwnProperty(dependencyPath)) {
              const property = this.searchProperty(dependencyPath);
              if (property) {
                let valueCheck
                if (this.schema.visibleIf.oneOf) {
                  valueCheck = property.valueChanges.pipe(map(
                    value => {
                      if (visibleIf[dependencyPath].indexOf('$ANY$') !== -1) {
                        return value.length > 0;
                      } else {
                        return visibleIf[dependencyPath].indexOf(value) !== -1;
                      }
                    }
                  ));
                } else if (this.schema.visibleIf.allOf) {
                  const _chk = (value) => {
                    for (const item of this.schema.visibleIf.allOf) {
                      for (const depPath of Object.keys(item)) {
                        const prop = this.searchProperty(depPath);
                        const propVal = prop._value;
                        let valid = false;
                        if (item[depPath].indexOf('$ANY$') !== -1) {
                          valid = propVal.length > 0;
                        } else {
                          valid = item[depPath].indexOf(propVal) !== -1;
                        }
                        if (!valid) {
                          return false;
                        }
                      }
                    }
                    return true;
                  };
                  valueCheck = property.valueChanges.pipe(map(_chk));
                }
                const visibilityCheck = property._visibilityChanges;
                const and = combineLatest([valueCheck, visibilityCheck], (v1, v2) => v1 && v2);
                propertiesBinding.push(and);
              } else {
                console.warn('Can\'t find property ' + dependencyPath + ' for visibility check of ' + this.path);
              }
            }
          }

          combineLatest(propertiesBinding, (...values: boolean[]) => {
            return values.indexOf(true) !== -1;
          }).pipe(distinctUntilChanged()).subscribe((visible) => {
            this.setVisible(visible);
          });
        }
      }
      return true;
    }
  }

  // A field is visible if AT LEAST ONE of the properties it depends on is visible AND has a value in the list
  public _bindVisibility() {
    if(this.__bindVisibility())
      return
    let visibleIf = this.schema.visibleIf;
    if (typeof visibleIf === 'object' && Object.keys(visibleIf).length === 0) {
      this.setVisible(false);
    }
    else if (visibleIf !== undefined) {
      let propertiesBinding = [];
      for (let dependencyPath in visibleIf) {
        if (visibleIf.hasOwnProperty(dependencyPath)) {
          let property = this.searchProperty(dependencyPath);
          if (property) {
            const valueCheck = property.valueChanges.pipe(map(
              value => {
                if (visibleIf[dependencyPath].indexOf('$ANY$') !== -1) {
                  return value.length > 0;
                } else {
                  return visibleIf[dependencyPath].indexOf(value) !== -1;
                }
              }
            ));
            const visibilityCheck = property._visibilityChanges;
            const and = combineLatest([valueCheck, visibilityCheck], (v1, v2) => v1 && v2);
            propertiesBinding.push(and);
          } else {
            console.warn('Can\'t find property ' + dependencyPath + ' for visibility check of ' + this.path);
          }
        }
      }

      combineLatest(propertiesBinding, (...values: boolean[]) => {
        return values.indexOf(true) !== -1;
      }).pipe(distinctUntilChanged()).subscribe((visible) => {
        this.setVisible(visible);
      });
    }
  }
}

export abstract class PropertyGroup extends FormProperty {

  properties: FormProperty[] | { [key: string]: FormProperty } = null;

  getProperty(path: string) {
    let subPathIdx = path.indexOf('/');
    let propertyId = subPathIdx !== -1 ? path.substr(0, subPathIdx) : path;

    let property = this.properties[propertyId];
    if (property !== null && subPathIdx !== -1 && property instanceof PropertyGroup) {
      let subPath = path.substr(subPathIdx + 1);
      property = (<PropertyGroup>property).getProperty(subPath);
    }
    return property;
  }

  public forEachChild(fn: (formProperty: FormProperty, str: String) => void) {
    for (let propertyId in this.properties) {
      if (this.properties.hasOwnProperty(propertyId)) {
        let property = this.properties[propertyId];
        fn(property, propertyId);
      }
    }
  }

  public forEachChildRecursive(fn: (formProperty: FormProperty) => void) {
    this.forEachChild((child) => {
      fn(child);
      if (child instanceof PropertyGroup) {
        (<PropertyGroup>child).forEachChildRecursive(fn);
      }
    });
  }

  public _bindVisibility() {
    super._bindVisibility();
    this._bindVisibilityRecursive();
  }

  private _bindVisibilityRecursive() {
    this.forEachChildRecursive((property) => {
      property._bindVisibility();
    });
  }

  public isRoot() {
    return this === this.root;
  }
}


